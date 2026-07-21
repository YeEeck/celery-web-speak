package httpapi

import (
	"context"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

const voiceReconcileTimeout = 5 * time.Second
const voiceEventRefreshDelay = 400 * time.Millisecond

func (s *Server) RunVoiceReconciler(ctx context.Context) {
	interval := s.cfg.VoiceReconcileInterval
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.reconcileVoiceRooms(ctx, "periodic")
		}
	}
}

func (s *Server) reconcileVoiceRooms(parent context.Context, source string) bool {
	if !s.voiceReconcileMu.TryLock() {
		return false
	}
	defer s.voiceReconcileMu.Unlock()

	ctx, cancel := context.WithTimeout(parent, voiceReconcileTimeout)
	defer cancel()
	channels, err := s.store.ListChannels(ctx)
	if err != nil {
		s.logger.Warn("list voice channels for reconciliation", "source", source, "error", err)
		return true
	}
	validChannels := make(map[int64]struct{})
	for _, channel := range channels {
		if channel.Type == store.ChannelTypeVoice {
			validChannels[channel.ID] = struct{}{}
		}
	}
	changed, err := s.media.Refresh(ctx)
	if err != nil {
		s.logger.Warn("reconcile livekit rooms", "source", source, "error", err)
		return true
	}
	pruned, pruneErr := s.media.DeleteRoomsExcept(ctx, validChannels)
	if pruneErr != nil {
		s.logger.Warn("delete orphan livekit rooms", "source", source, "error", pruneErr)
	}
	changed = changed || pruned
	if !changed {
		return true
	}
	rooms := s.media.VoiceRooms()
	participants := 0
	for _, room := range rooms {
		participants += len(room.Participants)
	}
	s.logger.Info("reconciled livekit rooms", "source", source, "rooms", len(rooms), "participants", participants)
	s.hub.Broadcast("voice_rooms", rooms)
	return true
}

func (s *Server) scheduleVoiceRoomRefresh(source string) {
	s.voiceRefreshMu.Lock()
	if s.voiceRefreshScheduled {
		s.voiceRefreshMu.Unlock()
		return
	}
	s.voiceRefreshScheduled = true
	s.voiceRefreshMu.Unlock()

	time.AfterFunc(voiceEventRefreshDelay, func() {
		s.voiceRefreshMu.Lock()
		s.voiceRefreshScheduled = false
		s.voiceRefreshMu.Unlock()
		if !s.reconcileVoiceRooms(context.Background(), source) {
			s.scheduleVoiceRoomRefresh(source)
		}
	})
}
