package media

import (
	"context"
	"time"
)

// VoiceTimeAccumulator persists whole seconds of voice participation by a
// user within a specific guild onto the (user, guild) running total. The
// media service calls it on a periodic VoiceRooms snapshot tick. A nil sink
// makes accumulation a no-op, which keeps the in-memory media tests free of
// a store dependency.
type VoiceTimeAccumulator interface {
	AddGuildVoiceTime(ctx context.Context, guildID, userID int64, seconds int64) error
}

// SetVoiceTimeAccumulator wires the store-backed sink used to persist voice
// time. It is intended to be called once during startup, before any tick
// runs.
func (s *Service) SetVoiceTimeAccumulator(sink VoiceTimeAccumulator) {
	s.voiceTime = sink
}

// TickVoiceTime snapshots VoiceRooms and credits each active (guild, user)
// pair with the whole seconds elapsed since the previous tick. The first
// call establishes the baseline and credits nothing. Failures from the sink
// are swallowed to keep voice flow resilient; the next tick retries nothing
// because elapsed time is recomputed from the wall clock, not accumulated in
// memory.
func (s *Service) TickVoiceTime(ctx context.Context) {
	s.voiceTimeMu.Lock()
	now := s.now()
	last := s.lastVoiceFlush
	if last.IsZero() {
		s.lastVoiceFlush = now
		s.voiceTimeMu.Unlock()
		return
	}
	s.lastVoiceFlush = now
	s.voiceTimeMu.Unlock()

	secs := int64(now.Sub(last) / time.Second)
	if secs <= 0 || s.voiceTime == nil {
		return
	}
	for _, room := range s.VoiceRooms() {
		if room.GuildID == 0 {
			continue
		}
		for _, participant := range room.Participants {
			_ = s.voiceTime.AddGuildVoiceTime(ctx, room.GuildID, participant.UserID, secs)
		}
	}
}

// FlushVoiceTime ticks once more to persist the segment ending at graceful
// shutdown. It is the voice-time analogue of Hub.FlushOnlineTime.
func (s *Service) FlushVoiceTime() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s.TickVoiceTime(ctx)
}
