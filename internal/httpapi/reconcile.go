package httpapi

import (
	"context"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

const voiceReconcileTimeout = 5 * time.Second

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

func (s *Server) reconcileVoiceRooms(parent context.Context, source string) {
	ctx, cancel := context.WithTimeout(parent, voiceReconcileTimeout)
	defer cancel()
	channels, err := s.store.ListChannels(ctx)
	if err != nil {
		s.logger.Warn("list voice channels for reconciliation", "source", source, "error", err)
		return
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
		return
	}
	pruned, pruneErr := s.media.DeleteRoomsExcept(ctx, validChannels)
	if pruneErr != nil {
		s.logger.Warn("delete orphan livekit rooms", "source", source, "error", pruneErr)
	}
	changed = changed || pruned
	if !changed {
		return
	}
	rooms := s.media.VoiceRooms()
	participants := 0
	for _, room := range rooms {
		participants += len(room.Participants)
	}
	s.logger.Info("reconciled livekit rooms", "source", source, "rooms", len(rooms), "participants", participants)
	s.hub.Broadcast("voice_rooms", rooms)
}
