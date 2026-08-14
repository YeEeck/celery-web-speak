package media

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"github.com/yeck/celery-web-speak/internal/store"
)

var (
	ErrCallNotFound   = errors.New("call not found")
	ErrCallWrongParty = errors.New("user is not a party to this call")
	ErrCallNotRinging = errors.New("call is not ringing")
	ErrCallNotActive  = errors.New("call is not active")
	// ErrCallBusy reports an initiation refused because the initiator is
	// already a party to a ringing or active call (spec 04: 忙碌 = 已有任一通话).
	ErrCallBusy = errors.New("caller is already in a call")
)

// CallState is the lifecycle phase of a 1:1 call, per spec 04. The terminal
// phase ended carries the reason the call finished via the call's EndReason.
type CallState string

const (
	CallRinging CallState = "ringing"
	CallActive  CallState = "active"
	CallEnded   CallState = "ended"
)

// CallEndReason records why a call reached the ended terminal state.
type CallEndReason string

const (
	CallEndBusy         CallEndReason = "busy"
	CallEndUnreachable  CallEndReason = "unreachable"
	CallEndRejected     CallEndReason = "rejected"
	CallEndCanceled     CallEndReason = "canceled"
	CallEndTimeout      CallEndReason = "timeout"
	CallEndNormal       CallEndReason = "ended"
	CallEndDisconnected CallEndReason = "disconnected"
)

// CallParty carries the render fields of one call party needed by the frontend
// signalling UI. It is captured at initiation so asynchronous terminal events
// (timeout, disconnect) can still describe the peer without a store read.
type CallParty struct {
	UserID      int64  `json:"userId"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

// CallSignal is one outbound point-to-point signalling event produced by the
// call state machine. The state machine computes the peer for the addressed
// party; httpapi wires delivery to its hub-backed CallSignaler.
type CallSignal struct {
	Type   string        `json:"type"`
	CallID int64         `json:"callId,string"`
	Peer   CallParty     `json:"peer"`
	State  CallState     `json:"state"`
	Reason CallEndReason `json:"reason,omitempty"`
}

// CallSignaler receives outbound call signalling events for delivery to a
// target account's own connections. httpapi registers a hub-backed
// implementation; a nil signaler makes emission a no-op for in-memory tests.
type CallSignaler interface {
	EmitCallSignal(targetUserID int64, signal CallSignal)
}

// SetCallSignaler wires the sink used to deliver call signalling events. It is
// intended to be called once during startup.
func (s *Service) SetCallSignaler(signaler CallSignaler) {
	s.mu.Lock()
	s.callSignaler = signaler
	s.mu.Unlock()
}

// callTarget is the per-user single-value target of the user's active call
// connection, mirroring the channel voiceTarget. A user may hold at most one
// channel target (targets[userID]) and one call target (callTargets[userID])
// simultaneously.
type callTarget struct {
	CallID     int64
	PeerID     int64
	RoomName   string
	Generation uint64
	ExpiresAt  time.Time
}

// call is the in-memory coordination state for a single call room. It tracks
// the two parties, the lifecycle phase (ringing/active/ended + terminal
// reason) and the participants currently connected to the room.
type call struct {
	CallID       int64
	CallerID     int64
	CalleeID     int64
	Caller       CallParty
	Callee       CallParty
	State        CallState
	EndReason    CallEndReason
	ExpiresAt    time.Time
	Participants map[int64]VoiceParticipant
}

func (c *call) otherParty(userID int64) int64 {
	if userID == c.CallerID {
		return c.CalleeID
	}
	return c.CallerID
}

func CallRoomName(callID int64) string {
	return "call-" + strconv.FormatInt(callID, 10)
}

func ParseCallRoomName(name string) (int64, bool) {
	callID, err := strconv.ParseInt(strings.TrimPrefix(name, "call-"), 10, 64)
	return callID, strings.HasPrefix(name, "call-") && err == nil && callID > 0
}

// StartCallResult describes the outcome of initiating a call: the allocated
// callID and its resulting phase. A terminated initiation (busy/unreachable)
// carries the terminal reason.
type StartCallResult struct {
	CallID int64         `json:"callId,string"`
	State  CallState     `json:"state"`
	Reason CallEndReason `json:"reason,omitempty"`
}

// StartCall performs the one-shot initiation arbitration (spec 04/05): an
// unreachable callee ends immediately, a busy callee (already in any ringing
// or active call) ends as busy, otherwise the call enters ringing and a 30s
// timeout is armed. The resulting signalling events are delivered to the
// registered CallSignaler. reachable is decided by the caller (httpapi) from
// shared-guild membership and online presence; busy is decided here from the
// in-memory call coordination.
//
// The initiation is refused with ErrCallBusy when the initiator is already a
// party to a ringing or active call with someone other than the intended
// callee (spec 04: 忙碌 = 已有任一通话). The mutual-dial case (the initiator's
// existing call involves the callee) is excluded: it is judged on the callee
// side by the busy branch below, per "双方互拨：后到判忙".
func (s *Service) StartCall(caller, callee store.User, reachable bool) (StartCallResult, error) {
	now := s.now()
	s.mu.Lock()
	if s.callerBusyElsewhereLocked(caller.ID, callee.ID) {
		s.mu.Unlock()
		return StartCallResult{}, ErrCallBusy
	}
	callID := s.nextCallIDLocked(now)
	state := CallRinging
	var reason CallEndReason
	switch {
	case !reachable:
		state = CallEnded
		reason = CallEndUnreachable
	case s.busyLocked(callee.ID):
		state = CallEnded
		reason = CallEndBusy
	}
	c := &call{
		CallID:       callID,
		CallerID:     caller.ID,
		CalleeID:     callee.ID,
		Caller:       CallParty{UserID: caller.ID, Username: caller.Username, DisplayName: caller.DisplayName},
		Callee:       CallParty{UserID: callee.ID, Username: callee.Username, DisplayName: callee.DisplayName},
		State:        state,
		EndReason:    reason,
		ExpiresAt:    now.Add(voiceTokenTTL),
		Participants: make(map[int64]VoiceParticipant),
	}
	s.calls[callID] = c
	s.revision++
	s.mu.Unlock()

	switch state {
	case CallEnded:
		// Immediate terminal start (busy/unreachable): the call never had
		// participants, so evict it right after the terminal signal.
		s.emit(caller.ID, callID, CallEnded, reason)
		s.mu.Lock()
		s.evictTerminalCallLocked(callID)
		s.mu.Unlock()
	case CallRinging:
		s.schedule(callRingTimeout, func() { s.timeoutCall(callID) })
		s.emit(callee.ID, callID, CallRinging, "")
	}
	return StartCallResult{CallID: callID, State: state, Reason: reason}, nil
}

// AcceptCall advances a ringing call whose callee is userID to active.
func (s *Service) AcceptCall(callID, userID int64) error {
	s.mu.Lock()
	c, exists := s.calls[callID]
	if !exists {
		s.mu.Unlock()
		return ErrCallNotFound
	}
	if c.State != CallRinging {
		s.mu.Unlock()
		return ErrCallNotRinging
	}
	if userID != c.CalleeID {
		s.mu.Unlock()
		return ErrCallWrongParty
	}
	c.State = CallActive
	s.revision++
	peerID := c.CallerID
	s.mu.Unlock()

	s.emit(peerID, callID, CallActive, "")
	return nil
}

// RejectCall ends a ringing call whose callee is userID, for reason rejected.
func (s *Service) RejectCall(callID, userID int64) error {
	return s.endRinging(callID, userID, true, CallEndRejected)
}

// CancelCall ends a ringing call whose caller is userID, for reason canceled.
func (s *Service) CancelCall(callID, userID int64) error {
	return s.endRinging(callID, userID, false, CallEndCanceled)
}

// HangUpCall ends an active call for either party, for reason ended. The other
// party receives the terminal call_end signal.
func (s *Service) HangUpCall(callID, userID int64) error {
	s.mu.Lock()
	c, exists := s.calls[callID]
	if !exists {
		s.mu.Unlock()
		return ErrCallNotFound
	}
	if c.State != CallActive {
		s.mu.Unlock()
		return ErrCallNotActive
	}
	if userID != c.CallerID && userID != c.CalleeID {
		s.mu.Unlock()
		return ErrCallWrongParty
	}
	c.State = CallEnded
	c.EndReason = CallEndNormal
	s.revision++
	peerID := c.otherParty(userID)
	s.mu.Unlock()

	s.emit(peerID, callID, CallEnded, CallEndNormal)

	// Hangup normally leaves both parties in Participants, so the call is
	// retained until the peers leave (via webhook/RemoveCallParticipant). Only
	// when a participant-less call is somehow active does this reclamation fire.
	s.mu.Lock()
	s.evictTerminalCallLocked(callID)
	s.mu.Unlock()
	return nil
}

// CallPeer returns the other party's user ID when userID is a party to the
// call. It backs the token endpoint, which must restrict credentials to the
// two parties only.
func (s *Service) CallPeer(callID, userID int64) (int64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, exists := s.calls[callID]
	if !exists {
		return 0, false
	}
	if userID == c.CallerID {
		return c.CalleeID, true
	}
	if userID == c.CalleeID {
		return c.CallerID, true
	}
	return 0, false
}

// endRinging terminates a ringing call initiated by a specific party and
// signals the other party. expectCallee selects the acting party: the callee
// rejects, the caller cancels.
func (s *Service) endRinging(callID, userID int64, expectCallee bool, reason CallEndReason) error {
	s.mu.Lock()
	c, exists := s.calls[callID]
	if !exists {
		s.mu.Unlock()
		return ErrCallNotFound
	}
	if c.State != CallRinging {
		s.mu.Unlock()
		return ErrCallNotRinging
	}
	actingID := c.CallerID
	if expectCallee {
		actingID = c.CalleeID
	}
	if userID != actingID {
		s.mu.Unlock()
		return ErrCallWrongParty
	}
	c.State = CallEnded
	c.EndReason = reason
	s.revision++
	peerID := c.otherParty(userID)
	s.mu.Unlock()

	s.emit(peerID, callID, CallEnded, reason)

	// A ringing call never has participants; evict it once the terminal
	// signal is out so the peer field remains resolvable for the emit above.
	s.mu.Lock()
	s.evictTerminalCallLocked(callID)
	s.mu.Unlock()
	return nil
}

// timeoutCall fires the 30s ring timeout: it ends the call only if it is still
// ringing. It is safe against a concurrent accept/reject/cancel, which would
// have already moved the call out of ringing.
func (s *Service) timeoutCall(callID int64) {
	s.mu.Lock()
	c, exists := s.calls[callID]
	if !exists || c.State != CallRinging {
		s.mu.Unlock()
		return
	}
	c.State = CallEnded
	c.EndReason = CallEndTimeout
	s.revision++
	callerID := c.CallerID
	calleeID := c.CalleeID
	s.mu.Unlock()

	s.emit(callerID, callID, CallEnded, CallEndTimeout)
	s.emit(calleeID, callID, CallEnded, CallEndTimeout)

	// A ringing call never has participants; evict it once both terminal
	// signals are out.
	s.mu.Lock()
	s.evictTerminalCallLocked(callID)
	s.mu.Unlock()
}

// evictTerminalCallLocked removes a terminal call that has no participants
// left to reference it. It is the in-memory reclamation path (spec 04): a
// ringing call that ends (reject/cancel/timeout) or an immediate terminal start
// (busy/unreachable) never builds a room and never gains participants, so it
// must be dropped as soon as its terminal signal is emitted rather than waiting
// for a room_finished that will never arrive. The caller must hold s.mu; it
// returns whether s.calls was mutated.
func (s *Service) evictTerminalCallLocked(callID int64) bool {
	c, exists := s.calls[callID]
	if !exists || c.State != CallEnded || len(c.Participants) != 0 {
		return false
	}
	delete(s.calls, callID)
	s.revision++
	return true
}

// busyLocked reports whether the user is a party to any ringing or active call.
// Being present in a voice channel is not busy, per spec 04. The caller must
// hold s.mu.
func (s *Service) busyLocked(userID int64) bool {
	for _, c := range s.calls {
		if (c.CallerID == userID || c.CalleeID == userID) && c.State != CallEnded {
			return true
		}
	}
	return false
}

// callerBusyElsewhereLocked reports whether the user is already a party to a
// ringing or active call with someone other than peerID. A call with peerID
// itself is excluded so mutual dial (A calls B while B calls A) keeps being
// judged on the callee side as busy (spec 04: 双方互拨：后到判忙).
func (s *Service) callerBusyElsewhereLocked(userID, peerID int64) bool {
	for _, c := range s.calls {
		if c.State == CallEnded {
			continue
		}
		if c.CallerID == userID && c.CalleeID != peerID {
			return true
		}
		if c.CalleeID == userID && c.CallerID != peerID {
			return true
		}
	}
	return false
}

// peerParty returns the counterpart of targetUserID's party within the call.
// It backs the "对方" field each outbound signal carries for frontend
// rendering. A zero CallParty is returned when targetUserID is not a party.
func (s *Service) peerParty(callID, targetUserID int64) CallParty {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, exists := s.calls[callID]
	if !exists {
		return CallParty{}
	}
	if targetUserID == c.CallerID {
		return c.Callee
	}
	if targetUserID == c.CalleeID {
		return c.Caller
	}
	return CallParty{}
}

// emit delivers one signalling event to a target account, computing the peer
// (the counterpart of targetUserID) from the current call coordination.
func (s *Service) emit(targetUserID, callID int64, state CallState, reason CallEndReason) {
	if s.callSignaler == nil {
		return
	}
	s.callSignaler.EmitCallSignal(targetUserID, CallSignal{
		Type:   callEventType(state, reason),
		CallID: callID,
		Peer:   s.peerParty(callID, targetUserID),
		State:  state,
		Reason: reason,
	})
}

func callEventType(state CallState, reason CallEndReason) string {
	if state != CallEnded {
		if state == CallActive {
			return "call_accept"
		}
		return "call_invite"
	}
	switch reason {
	case CallEndBusy:
		return "call_busy"
	case CallEndUnreachable:
		return "call_unreachable"
	case CallEndRejected:
		return "call_reject"
	case CallEndCanceled:
		return "call_cancel"
	case CallEndTimeout:
		return "call_timeout"
	default:
		return "call_end"
	}
}

// default grant (full publish and subscribe), per ADR 0032, and do not touch
// the user's channel connection.
func (s *Service) JoinCallCredentials(ctx context.Context, user store.User, callID, peerID int64) (JoinCredentials, error) {
	now := s.now()
	roomName := CallRoomName(callID)
	s.mu.Lock()
	c, exists := s.calls[callID]
	if !exists {
		s.mu.Unlock()
		return JoinCredentials{}, ErrCallNotFound
	}
	// Credentials are only issued once the call is connected (spec 05: both
	// parties fetch their token after call_accept). A ringing call must not
	// hand out a room-join token.
	if c.State != CallActive {
		s.mu.Unlock()
		return JoinCredentials{}, ErrCallNotActive
	}
	previous := s.callTargets[user.ID]
	generation := s.nextGenerationLocked(now)
	s.callTargets[user.ID] = callTarget{CallID: callID, PeerID: peerID, RoomName: roomName, Generation: generation, ExpiresAt: now.Add(voiceTokenTTL)}
	s.revision++
	s.mu.Unlock()

	grant := &auth.VideoGrant{RoomJoin: true, Room: roomName}
	attributes := map[string]string{
		"user_id":                strconv.FormatInt(user.ID, 10),
		"call_id":                strconv.FormatInt(callID, 10),
		VoiceGenerationAttribute: strconv.FormatUint(generation, 10),
	}
	token, err := auth.NewAccessToken(s.apiKey, s.apiSecret).
		SetIdentity(Identity(user.ID)).
		SetName(user.DisplayName).
		SetAttributes(attributes).
		SetVideoGrant(grant).
		SetValidFor(voiceTokenTTL).
		ToJWT()
	if err != nil {
		s.mu.Lock()
		if current := s.callTargets[user.ID]; current.Generation == generation {
			if previous.CallID > 0 {
				s.callTargets[user.ID] = previous
			} else {
				delete(s.callTargets, user.ID)
			}
			s.revision++
		}
		s.mu.Unlock()
		return JoinCredentials{}, fmt.Errorf("create call livekit token: %w", err)
	}
	return JoinCredentials{URL: s.publicURL, Token: token, RoomName: roomName, ChannelID: 0}, nil
}

// RemoveCallParticipant removes one participant from a call room and its call
// target, cleaning up the call coordination when the call empties. It leaves
// any channel connection untouched.
func (s *Service) RemoveCallParticipant(ctx context.Context, callID, userID int64) error {
	s.mu.RLock()
	target, hasTarget := s.callTargets[userID]
	c, exists := s.calls[callID]
	if !exists || !hasTarget || target.CallID != callID {
		s.mu.RUnlock()
		return ErrCallNotFound
	}
	participant := c.Participants[userID]
	roomName := CallRoomName(callID)
	s.mu.RUnlock()

	if _, err := s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: roomName, Identity: Identity(userID)}); err != nil {
		return err
	}

	s.mu.Lock()
	changed := false
	if c, exists := s.calls[callID]; exists {
		if stored, ok := c.Participants[userID]; !ok || stored.Generation == participant.Generation {
			delete(c.Participants, userID)
			changed = true
		}
		if len(c.Participants) == 0 {
			delete(s.calls, callID)
		}
	}
	if current, ok := s.callTargets[userID]; ok && current.CallID == callID {
		delete(s.callTargets, userID)
		changed = true
	}
	if changed {
		s.revision++
	}
	s.mu.Unlock()
	return nil
}

func (s *Service) applyCallWebhook(ctx context.Context, event *livekit.WebhookEvent, callID int64, roomName string) bool {
	switch event.GetEvent() {
	case webhook.EventParticipantJoined:
		participant, ok := voiceParticipant(event.GetParticipant())
		if !ok {
			return false
		}
		if participant.Generation == 0 {
			_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: roomName, Identity: participant.Identity})
			return false
		}
		s.mu.Lock()
		target := s.callTargets[participant.UserID]
		c, exists := s.calls[callID]
		if !exists {
			s.mu.Unlock()
			_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: roomName, Identity: participant.Identity})
			return false
		}
		if target.valid(s.now()) && !target.accepts(roomName, callID, participant.Generation) {
			s.mu.Unlock()
			_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: roomName, Identity: participant.Identity})
			return false
		}
		if c.Participants == nil {
			c.Participants = make(map[int64]VoiceParticipant)
		}
		c.Participants[participant.UserID] = participant
		if participant.Generation > s.generation {
			s.generation = participant.Generation
		}
		s.revision++
		s.mu.Unlock()
		return true
	case webhook.EventParticipantLeft:
		participant, ok := voiceParticipant(event.GetParticipant())
		if !ok {
			return false
		}
		s.mu.Lock()
		c, exists := s.calls[callID]
		if !exists {
			s.mu.Unlock()
			return false
		}
		stored, ok := c.Participants[participant.UserID]
		if !ok || (stored.Generation > 0 && participant.Generation > 0 && stored.Generation != participant.Generation) {
			s.mu.Unlock()
			return false
		}
		delete(c.Participants, participant.UserID)
		// A party leaving an active call (without a prior hangup) is a terminal
		// disconnect, per spec 04; signal the other party.
		var disconnectedTo int64
		if c.State == CallActive && (participant.UserID == c.CallerID || participant.UserID == c.CalleeID) {
			c.State = CallEnded
			c.EndReason = CallEndDisconnected
			disconnectedTo = c.otherParty(participant.UserID)
		}
		s.revision++
		s.mu.Unlock()
		if disconnectedTo > 0 {
			s.emit(disconnectedTo, callID, CallEnded, CallEndDisconnected)
		}
		// A terminal call whose last participant just left has nothing left to
		// reference it; evict it (re-check under lock after the emit so the
		// disconnect signal still resolves its peer).
		s.mu.Lock()
		s.evictTerminalCallLocked(callID)
		s.mu.Unlock()
		return true
	case webhook.EventRoomFinished:
		s.mu.Lock()
		if _, exists := s.calls[callID]; exists {
			delete(s.calls, callID)
			s.revision++
		}
		s.mu.Unlock()
		return true
	default:
		return false
	}
}

func (s *Service) nextCallIDLocked(now time.Time) int64 {
	callID := now.UnixNano()
	if callID <= s.callGeneration {
		callID = s.callGeneration + 1
	}
	s.callGeneration = callID
	return callID
}

func (target callTarget) valid(now time.Time) bool {
	return target.ExpiresAt.After(now)
}

func (target callTarget) accepts(roomName string, callID int64, generation uint64) bool {
	return target.CallID > 0 && generation >= target.Generation &&
		(generation != target.Generation || (callID == target.CallID && roomName == target.RoomName))
}

func cloneCall(c *call) *call {
	if c == nil {
		return nil
	}
	clone := *c
	clone.Participants = make(map[int64]VoiceParticipant, len(c.Participants))
	for userID, participant := range c.Participants {
		clone.Participants[userID] = participant
	}
	return &clone
}

func callTargetMapsEqual(a, b map[int64]callTarget) bool {
	if len(a) != len(b) {
		return false
	}
	for userID, target := range a {
		if other, ok := b[userID]; !ok || target != other {
			return false
		}
	}
	return true
}

func callMapsEqual(a, b map[int64]*call) bool {
	if len(a) != len(b) {
		return false
	}
	for callID, c := range a {
		other, ok := b[callID]
		if !ok || !callsEqual(c, other) {
			return false
		}
	}
	return true
}

func callsEqual(a, b *call) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.CallID != b.CallID || a.CallerID != b.CallerID || a.CalleeID != b.CalleeID || a.Caller != b.Caller || a.Callee != b.Callee || a.State != b.State || a.EndReason != b.EndReason || !a.ExpiresAt.Equal(b.ExpiresAt) {
		return false
	}
	if len(a.Participants) != len(b.Participants) {
		return false
	}
	for userID, participant := range a.Participants {
		if other, ok := b.Participants[userID]; !ok || participant != other {
			return false
		}
	}
	return true
}
