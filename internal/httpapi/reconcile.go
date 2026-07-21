package httpapi

import (
	"context"
	"time"
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
	changed, err := s.media.Refresh(ctx)
	if err != nil {
		s.logger.Warn("reconcile livekit rooms", "source", source, "error", err)
		return
	}
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
