package httpapi

import (
	"context"
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
	messages, messagesHasMore, err := s.store.ListMessages(r.Context(), 0, 50)
	if err != nil {
		s.internalError(w, "list messages", err)
		return
	}
	channels, err := s.store.ListChannels(r.Context())
	if err != nil {
		s.internalError(w, "list channels", err)
		return
	}
	readStates, err := s.store.ListChannelReadStates(r.Context(), currentUser(r).ID)
	if err != nil {
		s.internalError(w, "list channel read states", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":              currentUser(r),
		"users":             users,
		"messages":          messages,
		"messagesHasMore":   messagesHasMore,
		"onlineIds":         s.hub.OnlineUserIDs(),
		"channels":          channels,
		"channelReadStates": readStates,
		"voiceRooms":        s.media.VoiceRooms(),
	})
}

func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	messages, hasMore, err := s.store.ListMessages(r.Context(), before, limit)
	if err != nil {
		s.internalError(w, "list messages", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": messages, "hasMore": hasMore})
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
	channel, err := s.store.FirstChannel(r.Context(), store.ChannelTypeVoice)
	if err != nil {
		s.internalError(w, "get default voice channel", err)
		return
	}
	credentials, err := s.media.JoinCredentials(r.Context(), currentUser(r), channel.ID)
	if err != nil {
		s.internalError(w, "create voice token", err)
		return
	}
	writeJSON(w, http.StatusOK, credentials)
}

func (s *Server) handleVoiceLeave(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	err := s.media.RemoveParticipant(ctx, user.ID)
	cancel()
	if err != nil {
		s.logger.Warn("remove voice participant on leave", "user_id", user.ID, "error", err)
	}
	s.hub.Broadcast("voice_rooms", s.media.VoiceRooms())
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleVoiceState(w http.ResponseWriter, r *http.Request) {
	var state struct {
		Deafened bool `json:"deafened"`
	}
	if !decodeJSON(w, r, &state) {
		return
	}
	if err := s.media.SetDeafened(r.Context(), currentUser(r).ID, state.Deafened); err != nil {
		s.internalError(w, "update voice state", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
