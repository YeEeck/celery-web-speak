package media

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
)

func TestRoomNameRoundTrip(t *testing.T) {
	name := RoomName(42)
	channelID, ok := ParseRoomName(name)
	if name != "channel-42" || !ok || channelID != 42 {
		t.Fatalf("room name round trip = %q, %d, %t", name, channelID, ok)
	}
	for _, invalid := range []string{"main", "channel-0", "channel-nope", "other-42"} {
		if _, ok := ParseRoomName(invalid); ok {
			t.Fatalf("invalid room name %q was accepted", invalid)
		}
	}
}

func TestWebhookUpdatesVoiceRoomSnapshot(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	joined := &livekit.WebhookEvent{
		Event: webhook.EventParticipantJoined,
		Room:  &livekit.Room{Name: RoomName(7)},
		Participant: &livekit.ParticipantInfo{
			Identity:   Identity(12),
			Name:       "测试成员",
			JoinedAtMs: 1234,
			Attributes: map[string]string{"user_id": "12"},
		},
	}
	if !service.ApplyWebhook(context.Background(), joined) {
		t.Fatal("participant join did not change snapshot")
	}
	rooms := service.VoiceRooms()
	if len(rooms) != 1 || rooms[0].ChannelID != 7 || len(rooms[0].Participants) != 1 || rooms[0].Participants[0].UserID != 12 {
		t.Fatalf("voice rooms after join = %+v", rooms)
	}
	left := &livekit.WebhookEvent{
		Event:       webhook.EventParticipantLeft,
		Room:        joined.Room,
		Participant: joined.Participant,
	}
	if !service.ApplyWebhook(context.Background(), left) {
		t.Fatal("participant leave did not change snapshot")
	}
	rooms = service.VoiceRooms()
	if len(rooms) != 1 || len(rooms[0].Participants) != 0 {
		t.Fatalf("voice rooms after leave = %+v", rooms)
	}
}

func TestReplaceSnapshotDetectsChangesAndRejectsStaleRefresh(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	participant := VoiceParticipant{UserID: 12, Identity: Identity(12), Name: "测试成员", JoinedAt: 1234}
	rooms := map[int64]map[int64]VoiceParticipant{7: {12: participant}}
	targets := map[int64]voiceTarget{12: {ChannelID: 7, ExpiresAt: time.Now().Add(time.Minute)}}

	revision, _ := service.snapshotState()
	changed, applied := service.replaceSnapshot(revision, rooms, targets)
	if !changed || !applied {
		t.Fatalf("initial replace = changed %t, applied %t", changed, applied)
	}
	revision, _ = service.snapshotState()
	changed, applied = service.replaceSnapshot(revision, rooms, targets)
	if changed || !applied {
		t.Fatalf("identical replace = changed %t, applied %t", changed, applied)
	}

	staleRevision, _ := service.snapshotState()
	service.ApplyWebhook(context.Background(), &livekit.WebhookEvent{
		Event: webhook.EventParticipantLeft,
		Room:  &livekit.Room{Name: RoomName(7)},
		Participant: &livekit.ParticipantInfo{
			Identity: Identity(12), Attributes: map[string]string{"user_id": "12"},
		},
	})
	changed, applied = service.replaceSnapshot(staleRevision, rooms, targets)
	if changed || applied {
		t.Fatalf("stale replace = changed %t, applied %t", changed, applied)
	}
	if got := service.VoiceRooms(); len(got) != 1 || len(got[0].Participants) != 0 {
		t.Fatalf("stale replace overwrote webhook state: %+v", got)
	}
}

func TestLatestIssuedVoiceTokenRejectsDelayedOlderJoin(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	now := time.Date(2026, time.July, 21, 3, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	newGeneration := uint64(now.UnixNano())
	oldGeneration := newGeneration - 1
	service.targets[12] = voiceTarget{ChannelID: 8, Generation: newGeneration, ExpiresAt: now.Add(voiceTokenTTL)}

	oldJoin := participantEvent(webhook.EventParticipantJoined, 7, 12, oldGeneration)
	if service.ApplyWebhook(context.Background(), oldJoin) {
		t.Fatal("delayed old token changed the room snapshot")
	}
	if rooms := service.VoiceRooms(); len(rooms) != 0 {
		t.Fatalf("old token participant remained in snapshot: %+v", rooms)
	}

	newJoin := participantEvent(webhook.EventParticipantJoined, 8, 12, newGeneration)
	if !service.ApplyWebhook(context.Background(), newJoin) {
		t.Fatal("latest token did not join its target room")
	}
	if service.ApplyWebhook(context.Background(), oldJoin) {
		t.Fatal("old token replaced the latest connected participant")
	}
	rooms := service.VoiceRooms()
	if len(rooms) != 1 || rooms[0].ChannelID != 8 || len(rooms[0].Participants) != 1 {
		t.Fatalf("rooms after delayed old join = %+v", rooms)
	}
	if !service.ApplyWebhook(context.Background(), participantEvent(webhook.EventParticipantLeft, 8, 12, newGeneration)) {
		t.Fatal("latest participant leave did not update snapshot")
	}
	if service.ApplyWebhook(context.Background(), oldJoin) {
		t.Fatal("old token was accepted after the latest participant left")
	}
}

func TestDeleteRoomsExceptRemovesOrphanSnapshotAfterAPIFailure(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	if !service.ApplyWebhook(context.Background(), participantEvent(webhook.EventParticipantJoined, 99, 12, 0)) {
		t.Fatal("orphan participant did not enter snapshot")
	}
	changed, err := service.DeleteRoomsExcept(context.Background(), map[int64]struct{}{7: {}})
	if !changed || err == nil {
		t.Fatalf("prune result = changed %t, error %v; want changed with API error", changed, err)
	}
	if rooms := service.VoiceRooms(); len(rooms) != 0 {
		t.Fatalf("orphan room remained in snapshot: %+v", rooms)
	}
}

func participantEvent(event string, channelID, userID int64, generation uint64) *livekit.WebhookEvent {
	return &livekit.WebhookEvent{
		Event: event,
		Room:  &livekit.Room{Name: RoomName(channelID)},
		Participant: &livekit.ParticipantInfo{
			Identity: Identity(userID),
			Name:     "测试成员",
			Attributes: map[string]string{
				"user_id":                fmt.Sprint(userID),
				VoiceGenerationAttribute: fmt.Sprint(generation),
			},
		},
	}
}
