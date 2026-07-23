package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Type store.ChannelType `json:"type"`
		Name string            `json:"name"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	channel, err := s.store.CreateChannel(r.Context(), currentUser(r).ID, input.Type, input.Name)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.Broadcast("channel_created", channel)
	writeJSON(w, http.StatusCreated, map[string]any{"channel": channel})
}

func (s *Server) handleUpdateChannel(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		Name                       string `json:"name"`
		AudioBitrateKbps           int    `json:"audioBitrateKbps"`
		BackgroundAudioBitrateKbps int    `json:"backgroundAudioBitrateKbps"`
		MessageRetention           int    `json:"messageRetention"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	channel, err := s.store.UpdateChannel(r.Context(), currentUser(r).ID, channelID, input.Name, input.AudioBitrateKbps, input.BackgroundAudioBitrateKbps, input.MessageRetention)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.Broadcast("channel_updated", channel)
	writeJSON(w, http.StatusOK, map[string]any{"channel": channel})
}

func (s *Server) handleDeleteChannel(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	channel, err := s.store.DeleteChannel(r.Context(), currentUser(r).ID, channelID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if channel.Type == store.ChannelTypeVoice {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		err := s.media.DeleteRoom(ctx, channel.ID)
		cancel()
		if err != nil {
			s.logger.Warn("delete livekit room", "channel_id", channel.ID, "error", err)
		}
		s.hub.Broadcast("voice_rooms", s.media.VoiceRooms())
	}
	s.hub.Broadcast("channel_deleted", map[string]any{"id": channel.ID, "type": channel.Type})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListChannelMessages(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	messages, hasMore, err := s.store.ListChannelMessages(r.Context(), channelID, before, limit)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": messages, "hasMore": hasMore})
}

func (s *Server) handleCreateChannelMessage(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
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
	message, err := s.store.CreateChannelMessage(r.Context(), channelID, user, input.Content)
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

func (s *Server) handleDeleteChannelMessage(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "channelID")
	if !ok {
		return
	}
	messageID, ok := parsePathID(w, r, "messageID")
	if !ok {
		return
	}
	if err := s.store.DeleteChannelMessage(r.Context(), currentUser(r).ID, channelID, messageID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.Broadcast("message_deleted", map[string]int64{"channelId": channelID, "id": messageID})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMarkChannelRead(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	state, err := s.store.MarkChannelRead(r.Context(), currentUser(r).ID, channelID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.Broadcast("channel_read", map[string]any{"userId": currentUser(r).ID, "readState": state})
	writeJSON(w, http.StatusOK, map[string]any{"readState": state})
}

func (s *Server) handleChannelVoiceToken(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	channel, err := s.store.ChannelByID(r.Context(), channelID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if channel.Type != store.ChannelTypeVoice {
		writeError(w, http.StatusBadRequest, "invalid_channel_type", "该频道不是语音频道")
		return
	}
	credentials, err := s.media.JoinCredentials(r.Context(), currentUser(r), channelID)
	if err != nil {
		s.internalError(w, "create voice token", err)
		return
	}
	writeJSON(w, http.StatusOK, credentials)
}

func (s *Server) handleChannelVoiceState(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	var state struct {
		Deafened bool `json:"deafened"`
	}
	if !decodeJSON(w, r, &state) {
		return
	}
	if err := s.media.SetChannelDeafened(r.Context(), currentUser(r).ID, channelID, state.Deafened); err != nil {
		s.writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

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
		s.hub.Broadcast("voice_rooms", s.media.VoiceRooms())
	}
	w.WriteHeader(http.StatusNoContent)
}
