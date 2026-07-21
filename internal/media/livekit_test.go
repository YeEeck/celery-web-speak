package media

import (
	"context"
	"testing"

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
	targets := map[int64]int64{12: 7}

	revision := service.snapshotRevision()
	changed, applied := service.replaceSnapshot(revision, rooms, targets)
	if !changed || !applied {
		t.Fatalf("initial replace = changed %t, applied %t", changed, applied)
	}
	revision = service.snapshotRevision()
	changed, applied = service.replaceSnapshot(revision, rooms, targets)
	if changed || !applied {
		t.Fatalf("identical replace = changed %t, applied %t", changed, applied)
	}

	staleRevision := service.snapshotRevision()
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
