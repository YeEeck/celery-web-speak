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

var ErrCallNotFound = errors.New("call not found")

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
// the two parties and the participants currently connected to the room. The
// signalling lifecycle (ringing/active/ended) deliberately lives outside this
// shape and belongs to a later ticket.
type call struct {
	CallID       int64
	CallerID     int64
	CalleeID     int64
	ExpiresAt    time.Time
	Participants map[int64]VoiceParticipant
}

func CallRoomName(callID int64) string {
	return "call-" + strconv.FormatInt(callID, 10)
}

func ParseCallRoomName(name string) (int64, bool) {
	callID, err := strconv.ParseInt(strings.TrimPrefix(name, "call-"), 10, 64)
	return callID, strings.HasPrefix(name, "call-") && err == nil && callID > 0
}

// NewCall allocates the next monotonic callID and creates the call room
// coordination state, returning the callID. It performs no signalling and
// issues no tokens.
func (s *Service) NewCall(callerID, calleeID int64) int64 {
	now := s.now()
	s.mu.Lock()
	callID := s.nextCallIDLocked(now)
	s.calls[callID] = &call{
		CallID:       callID,
		CallerID:     callerID,
		CalleeID:     calleeID,
		ExpiresAt:    now.Add(voiceTokenTTL),
		Participants: make(map[int64]VoiceParticipant),
	}
	s.revision++
	s.mu.Unlock()
	return callID
}

// JoinCallCredentials issues a token for an existing call room. Tokens use the
// default grant (full publish and subscribe), per ADR 0032, and do not touch
// the user's channel connection.
func (s *Service) JoinCallCredentials(ctx context.Context, user store.User, callID, peerID int64) (JoinCredentials, error) {
	now := s.now()
	roomName := CallRoomName(callID)
	s.mu.Lock()
	if _, exists := s.calls[callID]; !exists {
		s.mu.Unlock()
		return JoinCredentials{}, ErrCallNotFound
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
		s.revision++
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
	if a.CallID != b.CallID || a.CallerID != b.CallerID || a.CalleeID != b.CalleeID || !a.ExpiresAt.Equal(b.ExpiresAt) {
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
