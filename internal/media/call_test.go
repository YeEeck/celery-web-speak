package media

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"github.com/yeck/celery-web-speak/internal/store"
)

func TestCallRoomNameRoundTrip(t *testing.T) {
	name := CallRoomName(12)
	if name != "call-12" {
		t.Fatalf("room name = %q", name)
	}
	callID, ok := ParseCallRoomName(name)
	if !ok || callID != 12 {
		t.Fatalf("parsed room = %d, %t", callID, ok)
	}
}

func TestParseCallRoomNameRejectsNonCall(t *testing.T) {
	for _, invalid := range []string{"guild-3-channel-7", "channel-7", "call-0", "call-nope", "main", ""} {
		if _, ok := ParseCallRoomName(invalid); ok {
			t.Fatalf("invalid call room name %q was accepted", invalid)
		}
	}
}

func TestStartCallAllocatesMonotonicCallIDs(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	service.now = func() time.Time { return time.Date(2026, time.July, 21, 3, 0, 0, 0, time.UTC) }

	// Two independent initiations (different callers, since one caller can only
	// hold one call) still allocate increasing call IDs.
	first := mustStart(t, service, store.User{ID: 100, Username: "a", DisplayName: "甲"}, store.User{ID: 200, Username: "b", DisplayName: "乙"}, true)
	second := mustStart(t, service, store.User{ID: 300, Username: "c", DisplayName: "丙"}, store.User{ID: 400, Username: "d", DisplayName: "丁"}, true)
	if first.CallID <= 0 || second.CallID <= first.CallID {
		t.Fatalf("call ids = %d, %d; want positive and increasing", first.CallID, second.CallID)
	}
	if len(service.calls) != 2 {
		t.Fatalf("calls tracked = %d, want 2", len(service.calls))
	}
	if c := service.calls[first.CallID]; c == nil || c.CallerID != 100 || c.CalleeID != 200 || len(c.Participants) != 0 {
		t.Fatalf("call %d = %+v", first.CallID, c)
	}
}

// newRingingCall starts a call via the production StartCall path and returns
// the callID, for tests that need an existing ringing call without caring
// about the signalling side.
func newRingingCall(t *testing.T, service *Service, callerID, calleeID int64) int64 {
	t.Helper()
	caller := store.User{ID: callerID, Username: "caller", DisplayName: "主叫"}
	callee := store.User{ID: calleeID, Username: "callee", DisplayName: "被叫"}
	return mustStart(t, service, caller, callee, true).CallID
}

func TestCallTokenAllowsFullPublishSubscribe(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	callID := newRingingCall(t, service, 100, 200)
	// Credentials are only issued once the call is active (spec 05).
	if err := service.AcceptCall(callID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	credentials, err := service.JoinCallCredentials(context.Background(), store.User{
		ID: 100, Username: "caller", DisplayName: "主叫",
	}, callID, 200)
	if err != nil {
		t.Fatalf("join call credentials: %v", err)
	}
	if credentials.RoomName != CallRoomName(callID) {
		t.Fatalf("room name = %q, want %q", credentials.RoomName, CallRoomName(callID))
	}
	verifier, err := auth.ParseAPIToken(credentials.Token)
	if err != nil {
		t.Fatalf("parse token: %v", err)
	}
	_, claims, err := verifier.Verify("secret")
	if err != nil {
		t.Fatalf("verify token: %v", err)
	}
	if !claims.Video.RoomJoin || claims.Video.Room != CallRoomName(callID) {
		t.Fatalf("video grant = %+v", claims.Video)
	}
	if claims.Video.CanPublish != nil {
		t.Fatalf("call token should leave publishing unrestricted (nil CanPublish), got %+v", claims.Video)
	}
	if len(claims.Video.CanPublishSources) != 0 {
		t.Fatalf("call token publish sources = %v, want unrestricted", claims.Video.CanPublishSources)
	}
	if claims.Attributes["user_id"] != "100" {
		t.Fatalf("user_id attribute = %q", claims.Attributes["user_id"])
	}
	if claims.Attributes["call_id"] == "" {
		t.Fatalf("call_id attribute missing")
	}
}

func TestCallWebhookParticipantJoinedAndLeft(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	callID := newRingingCall(t, service, 100, 200)
	generation := uint64(time.Now().UnixNano())
	joined := callParticipantEvent(webhook.EventParticipantJoined, callID, 100, generation)
	if !service.ApplyWebhook(context.Background(), joined) {
		t.Fatal("call participant join did not change snapshot")
	}
	if rooms := service.VoiceRooms(); len(rooms) != 0 {
		t.Fatalf("channel voice rooms polluted by call join: %+v", rooms)
	}
	if c := service.calls[callID]; c == nil || len(c.Participants) != 1 || c.Participants[100].UserID != 100 {
		t.Fatalf("call after join = %+v", c)
	}
	left := callParticipantEvent(webhook.EventParticipantLeft, callID, 100, generation)
	if !service.ApplyWebhook(context.Background(), left) {
		t.Fatal("call participant leave did not change snapshot")
	}
	if c := service.calls[callID]; c == nil || len(c.Participants) != 0 {
		t.Fatalf("call after leave = %+v", c)
	}
}

func TestCallWebhookRoomFinishedRemovesCall(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	callID := newRingingCall(t, service, 100, 200)
	if !service.ApplyWebhook(context.Background(), &livekit.WebhookEvent{
		Event: webhook.EventRoomFinished,
		Room:  &livekit.Room{Name: CallRoomName(callID)},
	}) {
		t.Fatal("call room finished did not change snapshot")
	}
	if _, exists := service.calls[callID]; exists {
		t.Fatalf("call coordination remained after room finished")
	}
}

func TestChannelWebhookDoesNotTouchCall(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	callID := newRingingCall(t, service, 100, 200)
	generation := uint64(time.Now().UnixNano())
	if !service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantJoined, callID, 100, generation)) {
		t.Fatal("call join did not change snapshot")
	}
	// A channel participant leaving must not affect the call participant.
	if service.ApplyWebhook(context.Background(), participantEvent(webhook.EventParticipantLeft, 7, 100, generation)) {
		t.Fatal("channel participant leave changed the snapshot")
	}
	if c := service.calls[callID]; c == nil || len(c.Participants) != 1 {
		t.Fatalf("call participant removed by channel webhook: %+v", c)
	}
}

func TestRemoveCallParticipantIsolatesFromChannel(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	room := &recordingRoomService{}
	service.room = room
	generation := uint64(time.Now().UnixNano())
	service.targets[100] = voiceTarget{GuildID: 3, ChannelID: 7, RoomName: GuildRoomName(3, 7), Generation: generation, ExpiresAt: time.Now().Add(time.Minute)}
	service.rooms[7] = map[int64]VoiceParticipant{100: {UserID: 100, Generation: generation}}
	callID := newRingingCall(t, service, 100, 200)
	service.callTargets[100] = callTarget{CallID: callID, PeerID: 200, RoomName: CallRoomName(callID), Generation: generation, ExpiresAt: time.Now().Add(time.Minute)}
	service.calls[callID].Participants[100] = VoiceParticipant{UserID: 100, Generation: generation}

	if err := service.RemoveCallParticipant(context.Background(), callID, 100); err != nil {
		t.Fatalf("remove call participant: %v", err)
	}
	if target := service.currentTarget(100); target.ChannelID != 7 || target.GuildID != 3 {
		t.Fatalf("channel connection removed by call cleanup: %+v", target)
	}
	if _, exists := service.rooms[7][100]; !exists {
		t.Fatalf("channel participant removed by call cleanup")
	}
	if _, exists := service.calls[callID]; exists {
		t.Fatalf("empty call coordination remained after last participant removed")
	}
	if _, exists := service.callTargets[100]; exists {
		t.Fatalf("call target remained after participant removed")
	}
	if room.removed == nil || room.removed.Room != CallRoomName(callID) || room.removed.Identity != Identity(100) {
		t.Fatalf("remove request = %+v", room.removed)
	}
}

func TestRemoveParticipantLeavesCallConnectionIntact(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	service.room = &recordingRoomService{}
	generation := uint64(time.Now().UnixNano())
	service.targets[100] = voiceTarget{GuildID: 3, ChannelID: 7, RoomName: GuildRoomName(3, 7), Generation: generation, ExpiresAt: time.Now().Add(time.Minute)}
	service.rooms[7] = map[int64]VoiceParticipant{100: {UserID: 100, Generation: generation}}
	callID := newRingingCall(t, service, 100, 200)
	service.callTargets[100] = callTarget{CallID: callID, PeerID: 200, RoomName: CallRoomName(callID), Generation: generation, ExpiresAt: time.Now().Add(time.Minute)}
	service.calls[callID].Participants[100] = VoiceParticipant{UserID: 100, Generation: generation}

	if err := service.RemoveParticipant(context.Background(), 100); err != nil {
		t.Fatalf("remove channel participant: %v", err)
	}
	if _, exists := service.calls[callID]; !exists {
		t.Fatalf("call coordination removed by channel cleanup")
	}
	if _, exists := service.calls[callID].Participants[100]; !exists {
		t.Fatalf("call participant removed by channel cleanup")
	}
	if target := service.callTargets[100]; target.CallID != callID {
		t.Fatalf("call target removed by channel cleanup: %+v", target)
	}
	if _, exists := service.rooms[7][100]; exists {
		t.Fatalf("channel participant survived RemoveParticipant")
	}
}

func TestDeleteRoomsExceptDoesNotTouchCallRooms(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	service.room = &recordingRoomService{}
	callID := newRingingCall(t, service, 100, 200)
	generation := uint64(time.Now().UnixNano())
	service.callTargets[100] = callTarget{CallID: callID, PeerID: 200, RoomName: CallRoomName(callID), Generation: generation, ExpiresAt: time.Now().Add(time.Minute)}
	service.calls[callID].Participants[100] = VoiceParticipant{UserID: 100, Generation: generation}

	changed, err := service.DeleteRoomsExcept(context.Background(), map[int64]struct{}{})
	if changed {
		t.Fatalf("delete rooms except reported change for call-only service")
	}
	if err != nil {
		t.Fatalf("delete rooms except: %v", err)
	}
	if _, exists := service.calls[callID]; !exists {
		t.Fatalf("call coordination removed by channel cleanup")
	}
}

func TestDeleteGuildRoomDoesNotTouchCallRooms(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	service.room = &recordingRoomService{}
	callID := newRingingCall(t, service, 100, 200)
	generation := uint64(time.Now().UnixNano())
	service.callTargets[100] = callTarget{CallID: callID, PeerID: 200, RoomName: CallRoomName(callID), Generation: generation, ExpiresAt: time.Now().Add(time.Minute)}
	service.calls[callID].Participants[100] = VoiceParticipant{UserID: 100, Generation: generation}
	service.targets[100] = voiceTarget{GuildID: 3, ChannelID: 7, RoomName: GuildRoomName(3, 7), Generation: generation, ExpiresAt: time.Now().Add(time.Minute)}

	if err := service.DeleteGuildRoom(context.Background(), 3, 7); err != nil {
		t.Fatalf("delete guild room: %v", err)
	}
	if _, exists := service.calls[callID]; !exists {
		t.Fatalf("call coordination removed by guild room cleanup")
	}
}

func TestRefreshReconcilesCallRoomSeparately(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	callID := newRingingCall(t, service, 100, 200)
	generation := uint64(time.Now().UnixNano())
	service.callTargets[100] = callTarget{CallID: callID, PeerID: 200, RoomName: CallRoomName(callID), Generation: generation, ExpiresAt: time.Now().Add(time.Minute)}
	service.room = &listingRoomService{
		rooms: []*livekit.Room{{Name: CallRoomName(callID)}},
		participants: map[string][]*livekit.ParticipantInfo{
			CallRoomName(callID): {{
				Identity:   Identity(100),
				Name:       "主叫",
				Attributes: map[string]string{"user_id": "100", VoiceGenerationAttribute: fmt.Sprint(generation)},
			}},
		},
	}

	if _, err := service.Refresh(context.Background()); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if c := service.calls[callID]; c == nil || len(c.Participants) != 1 {
		t.Fatalf("call participants after refresh = %+v", c)
	}
	if rooms := service.VoiceRooms(); len(rooms) != 0 {
		t.Fatalf("channel voice rooms polluted by call refresh: %+v", rooms)
	}
}

func callParticipantEvent(event string, callID, userID int64, generation uint64) *livekit.WebhookEvent {
	return &livekit.WebhookEvent{
		Event: event,
		Room:  &livekit.Room{Name: CallRoomName(callID)},
		Participant: &livekit.ParticipantInfo{
			Identity: Identity(userID),
			Name:     "通话成员",
			Attributes: map[string]string{
				"user_id":                fmt.Sprint(userID),
				"call_id":                fmt.Sprint(callID),
				VoiceGenerationAttribute: fmt.Sprint(generation),
			},
		},
	}
}

type listingRoomService struct {
	rooms        []*livekit.Room
	participants map[string][]*livekit.ParticipantInfo
}

func (l *listingRoomService) ListRooms(context.Context, *livekit.ListRoomsRequest) (*livekit.ListRoomsResponse, error) {
	return &livekit.ListRoomsResponse{Rooms: l.rooms}, nil
}

func (l *listingRoomService) DeleteRoom(context.Context, *livekit.DeleteRoomRequest) (*livekit.DeleteRoomResponse, error) {
	return &livekit.DeleteRoomResponse{}, nil
}

func (l *listingRoomService) ListParticipants(_ context.Context, req *livekit.ListParticipantsRequest) (*livekit.ListParticipantsResponse, error) {
	return &livekit.ListParticipantsResponse{Participants: l.participants[req.Room]}, nil
}

func (l *listingRoomService) RemoveParticipant(context.Context, *livekit.RoomParticipantIdentity) (*livekit.RemoveParticipantResponse, error) {
	return &livekit.RemoveParticipantResponse{}, nil
}

func (l *listingRoomService) UpdateParticipant(context.Context, *livekit.UpdateParticipantRequest) (*livekit.ParticipantInfo, error) {
	return &livekit.ParticipantInfo{}, nil
}
