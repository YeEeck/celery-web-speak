package httpapi

import (
	"context"
	"net/http"
	"time"
)

func (s *Server) handleLiveKitWebhook(w http.ResponseWriter, r *http.Request) {
	event, err := s.media.ReceiveWebhook(r)
	if err != nil {
		s.logger.Warn("reject livekit webhook", "error", err)
		writeError(w, http.StatusUnauthorized, "invalid_webhook", "Webhook 签名无效")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	changed := s.media.ApplyWebhook(ctx, event)
	cancel()
	if changed {
		s.broadcastVoiceRooms(r.Context())
	}
	w.WriteHeader(http.StatusNoContent)
}
