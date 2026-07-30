package media

import (
	"context"
	"slices"
	"testing"
	"time"
)

type fakeVoiceSink struct {
	calls []voiceSinkCall
}

type voiceSinkCall struct {
	guildID int64
	userID  int64
	seconds int64
}

func (f *fakeVoiceSink) AddGuildVoiceTime(_ context.Context, guildID, userID int64, seconds int64) error {
	f.calls = append(f.calls, voiceSinkCall{guildID: guildID, userID: userID, seconds: seconds})
	return nil
}

// newVoiceTimeService returns a Service seeded with a fake sink and a
// controllable now() so tick deltas are deterministic.
func newVoiceTimeService(now time.Time) *Service {
	s := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	s.now = func() time.Time { return now }
	return s
}

func TestTickVoiceTimeFirstCallIsBaselineNoop(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	s := newVoiceTimeService(now)
	sink := &fakeVoiceSink{}
	s.SetVoiceTimeAccumulator(sink)
	// Seed a populated room so a naive accumulator would otherwise emit.
	s.targets[12] = voiceTarget{GuildID: 3, ChannelID: 8, RoomName: GuildRoomName(3, 8), ExpiresAt: now.Add(voiceTokenTTL)}
	s.rooms[8] = map[int64]VoiceParticipant{12: {UserID: 12, JoinedAt: now.UnixMilli()}}

	s.TickVoiceTime(context.Background())
	if len(sink.calls) != 0 {
		t.Fatalf("first tick emitted %d calls, want 0: %+v", len(sink.calls), sink.calls)
	}
	if !s.lastVoiceFlush.Equal(now) {
		t.Fatalf("lastVoiceFlush = %v, want %v", s.lastVoiceFlush, now)
	}
}

func TestTickVoiceTimeCreditsEachActiveGuildUserPair(t *testing.T) {
	t0 := time.Unix(1_000_000, 0)
	s := newVoiceTimeService(t0)
	sink := &fakeVoiceSink{}
	s.SetVoiceTimeAccumulator(sink)
	s.TickVoiceTime(context.Background()) // establish baseline

	// Seed two rooms across two guilds with three participants between them.
	now := t0.Add(120 * time.Second)
	s.now = func() time.Time { return now }
	s.targets[12] = voiceTarget{GuildID: 3, ChannelID: 8, RoomName: GuildRoomName(3, 8), ExpiresAt: now.Add(voiceTokenTTL)}
	s.rooms[8] = map[int64]VoiceParticipant{
		12: {UserID: 12, JoinedAt: now.UnixMilli()},
		34: {UserID: 34, JoinedAt: now.UnixMilli()},
	}
	s.targets[56] = voiceTarget{GuildID: 5, ChannelID: 9, RoomName: GuildRoomName(5, 9), ExpiresAt: now.Add(voiceTokenTTL)}
	s.rooms[9] = map[int64]VoiceParticipant{78: {UserID: 78, JoinedAt: now.UnixMilli()}}

	s.TickVoiceTime(context.Background())

	want := []voiceSinkCall{
		{guildID: 3, userID: 12, seconds: 120},
		{guildID: 3, userID: 34, seconds: 120},
		{guildID: 5, userID: 78, seconds: 120},
	}
	// Order is not guaranteed across rooms/participants; sort observed calls
	// for a stable comparison.
	slices.SortFunc(sink.calls, func(a, b voiceSinkCall) int {
		if a.guildID != b.guildID {
			if a.guildID < b.guildID {
				return -1
			}
			return 1
		}
		if a.userID < b.userID {
			return -1
		}
		if a.userID > b.userID {
			return 1
		}
		return 0
	})
	if !slices.Equal(sink.calls, want) {
		t.Fatalf("sink calls = %+v, want %+v", sink.calls, want)
	}
}

func TestTickVoiceTimeSkipsRoomsWithoutGuildTarget(t *testing.T) {
	t0 := time.Unix(2_000_000, 0)
	s := newVoiceTimeService(t0)
	sink := &fakeVoiceSink{}
	s.SetVoiceTimeAccumulator(sink)
	s.TickVoiceTime(context.Background())

	now := t0.Add(60 * time.Second)
	s.now = func() time.Time { return now }
	// Room with no matching target → guildForChannelLocked returns 0.
	s.rooms[8] = map[int64]VoiceParticipant{12: {UserID: 12, JoinedAt: now.UnixMilli()}}

	s.TickVoiceTime(context.Background())
	if len(sink.calls) != 0 {
		t.Fatalf("expected no calls for guild-less room, got %+v", sink.calls)
	}
}

func TestTickVoiceTimeNilSinkIsSafe(t *testing.T) {
	t0 := time.Unix(3_000_000, 0)
	s := newVoiceTimeService(t0)
	// No SetVoiceTimeAccumulator call: sink stays nil.
	s.TickVoiceTime(context.Background()) // baseline
	now := t0.Add(60 * time.Second)
	s.now = func() time.Time { return now }
	s.targets[12] = voiceTarget{GuildID: 3, ChannelID: 8, RoomName: GuildRoomName(3, 8), ExpiresAt: now.Add(voiceTokenTTL)}
	s.rooms[8] = map[int64]VoiceParticipant{12: {UserID: 12, JoinedAt: now.UnixMilli()}}

	// Must not panic and must not emit anything.
	s.TickVoiceTime(context.Background())
}
