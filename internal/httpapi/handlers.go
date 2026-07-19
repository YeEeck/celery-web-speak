package httpapi

import (
	"net/http"
	"strconv"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		s.internalError(w, "list users", err)
		return
	}
	settings, err := s.store.Settings(r.Context())
	if err != nil {
		s.internalError(w, "get settings", err)
		return
	}
	messages, err := s.store.ListMessages(r.Context(), 0, 50)
	if err != nil {
		s.internalError(w, "list messages", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":      currentUser(r),
		"users":     users,
		"settings":  settings,
		"messages":  messages,
		"onlineIds": s.hub.OnlineUserIDs(),
	})
}

func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	messages, err := s.store.ListMessages(r.Context(), before, limit)
	if err != nil {
		s.internalError(w, "list messages", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": messages})
}

func (s *Server) handleCreateMessage(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	if !s.allowMessage(user.ID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "消息发送过快，请稍后再试")
		return
	}
	var input struct {
		Content string `json:"content"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	message, err := s.store.CreateMessage(r.Context(), user, input.Content)
	if err != nil {
		if err.Error() == "text muted" {
			writeError(w, http.StatusForbidden, "text_muted", "你已被文字禁言")
		} else {
			s.writeStoreError(w, err)
		}
		return
	}
	s.hub.Broadcast("message_created", message)
	writeJSON(w, http.StatusCreated, map[string]any{"message": message})
}

func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteMessage(r.Context(), currentUser(r).ID, id); err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.Broadcast("message_deleted", map[string]int64{"id": id})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleVoiceToken(w http.ResponseWriter, r *http.Request) {
	credentials, err := s.media.JoinCredentials(currentUser(r))
	if err != nil {
		s.internalError(w, "create voice token", err)
		return
	}
	writeJSON(w, http.StatusOK, credentials)
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var settings store.ChannelSettings
	if !decodeJSON(w, r, &settings) {
		return
	}
	if err := s.store.UpdateSettings(r.Context(), currentUser(r).ID, settings); err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.Broadcast("settings_updated", settings)
	writeJSON(w, http.StatusOK, map[string]any{"settings": settings})
}

func (s *Server) allowMessage(userID int64) bool {
	now := time.Now()
	cutoff := now.Add(-10 * time.Second)
	s.limiterMu.Lock()
	defer s.limiterMu.Unlock()
	previous := s.limits[userID]
	recent := previous[:0]
	for _, timestamp := range previous {
		if timestamp.After(cutoff) {
			recent = append(recent, timestamp)
		}
	}
	if len(recent) >= 8 {
		s.limits[userID] = recent
		return false
	}
	s.limits[userID] = append(recent, now)
	return true
}

func (s *Server) internalError(w http.ResponseWriter, operation string, err error) {
	s.logger.Error(operation, "error", err)
	writeError(w, http.StatusInternalServerError, "internal_error", "服务器处理请求时出现错误")
}
