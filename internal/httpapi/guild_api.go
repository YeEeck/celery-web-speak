package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

type guildContextKey int

const guildMembershipContextKey guildContextKey = iota

func guildIDFromRequest(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("serverID"), 10, 64)
	if err != nil || id < 1 {
		return 0, errors.New("invalid server id")
	}
	return id, nil
}

func guildMembership(r *http.Request) store.GuildMember {
	return r.Context().Value(guildMembershipContextKey).(store.GuildMember)
}

func (s *Server) requireGuildMember(next http.Handler) http.Handler {
	return s.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		guildID, err := guildIDFromRequest(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_id", "服务器编号无效")
			return
		}
		member, err := s.store.GuildMembership(r.Context(), guildID, currentUser(r).ID)
		if err != nil {
			if currentUser(r).IsPlatformAdmin {
				writeError(w, http.StatusForbidden, "server_membership_required", "请先加入该服务器")
				return
			}
			writeError(w, http.StatusNotFound, "not_found", "服务器不存在")
			return
		}
		if member.PermanentlyBanned || (member.TemporaryBanUntil != nil && member.TemporaryBanUntil.After(time.Now())) {
			writeError(w, http.StatusForbidden, "server_banned", "你当前无法访问该服务器")
			return
		}
		next.ServeHTTP(w, r.WithContext(withGuildMembership(r.Context(), member)))
	}))
}

func withGuildMembership(ctx context.Context, member store.GuildMember) context.Context {
	return context.WithValue(ctx, guildMembershipContextKey, member)
}

func (s *Server) requireGuildAdmin(next http.Handler) http.Handler {
	return s.requireGuildMember(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !guildMembership(r).Role.IsAdmin() {
			writeError(w, http.StatusForbidden, "forbidden", "需要服务器管理员权限")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (s *Server) requireDefaultGuildMember(next http.Handler) http.Handler {
	return s.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		guildID, err := s.store.DefaultGuildID(r.Context())
		if err != nil {
			writeError(w, http.StatusNotFound, "not_found", "资源不存在")
			return
		}
		member, err := s.store.GuildMembership(r.Context(), guildID, currentUser(r).ID)
		if err != nil {
			writeError(w, http.StatusNotFound, "not_found", "资源不存在")
			return
		}
		next.ServeHTTP(w, r.WithContext(withGuildMembership(r.Context(), member)))
	}))
}

func (s *Server) requireDefaultGuildAdmin(next http.Handler) http.Handler {
	return s.requireDefaultGuildMember(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !guildMembership(r).Role.IsAdmin() {
			writeError(w, http.StatusForbidden, "forbidden", "需要服务器管理员权限")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (s *Server) requirePlatformAdmin(next http.Handler) http.Handler {
	return s.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !currentUser(r).IsPlatformAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "需要平台管理员权限")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (s *Server) handlePlatformServers(w http.ResponseWriter, r *http.Request) {
	servers, err := s.store.ListGuildsForUser(r.Context(), currentUser(r).ID, true)
	if err != nil {
		s.internalError(w, "list platform servers", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"servers": servers})
}

func (s *Server) handlePlatformCreateServer(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name          string `json:"name"`
		OwnerUsername string `json:"ownerUsername"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	guild, err := s.store.CreateGuild(r.Context(), currentUser(r).ID, input.Name, input.OwnerUsername)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"server": guild})
}

func (s *Server) handlePlatformJoinServer(w http.ResponseWriter, r *http.Request) {
	guildID, err := guildIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "服务器编号无效")
		return
	}
	member, err := s.store.JoinGuildAsAdmin(r.Context(), guildID, currentUser(r).ID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"member": member})
}

func (s *Server) handlePlatformServerOwner(w http.ResponseWriter, r *http.Request) {
	guildID, err := guildIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "服务器编号无效")
		return
	}
	var input struct {
		UserID int64 `json:"userId"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	guild, err := s.store.TransferGuildOwnership(r.Context(), guildID, currentUser(r).ID, input.UserID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"server": guild})
}

func (s *Server) handlePlatformDeleteServer(w http.ResponseWriter, r *http.Request) {
	guildID, err := guildIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "服务器编号无效")
		return
	}
	if err := s.store.DeleteGuild(r.Context(), guildID, currentUser(r).ID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleServerBootstrap(w http.ResponseWriter, r *http.Request) {
	guildID := guildMembership(r).GuildID
	channels, err := s.store.ListGuildChannels(r.Context(), guildID)
	if err != nil {
		s.internalError(w, "list server channels", err)
		return
	}
	members, err := s.store.ListGuildMembers(r.Context(), guildID)
	if err != nil {
		s.internalError(w, "list server members", err)
		return
	}
	readStates, err := s.store.ListChannelReadStates(r.Context(), currentUser(r).ID)
	if err != nil {
		s.internalError(w, "list server read states", err)
		return
	}
	filteredRead := make([]store.ChannelReadState, 0, len(readStates))
	for _, state := range readStates {
		channel, err := s.store.GuildChannelByID(r.Context(), guildID, state.ChannelID)
		if err == nil && channel.Type == store.ChannelTypeText {
			filteredRead = append(filteredRead, state)
		}
	}
	voiceRooms := s.media.VoiceRooms()
	filteredVoice := voiceRooms[:0]
	for _, room := range voiceRooms {
		if room.GuildID == guildID {
			filteredVoice = append(filteredVoice, room)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"server": s.mustGuild(r, guildID), "membership": guildMembership(r), "members": members, "channels": channels, "channelReadStates": filteredRead, "onlineIds": s.hub.OnlineGuildUserIDs(guildID), "voiceRooms": filteredVoice})
}

func (s *Server) mustGuild(r *http.Request, id int64) store.Guild {
	guild, _ := s.store.GuildByID(r.Context(), id)
	return guild
}

func (s *Server) handleServerRename(w http.ResponseWriter, r *http.Request) {
	guildID := guildMembership(r).GuildID
	if guildMembership(r).Role != store.GuildRoleOwner {
		writeError(w, http.StatusForbidden, "forbidden", "只有服务器所有者可以重命名")
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	guild, err := s.store.RenameGuild(r.Context(), guildID, currentUser(r).ID, input.Name)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"server": guild})
}

func (s *Server) handleServerMembers(w http.ResponseWriter, r *http.Request) {
	members, err := s.store.ListGuildMembers(r.Context(), guildMembership(r).GuildID)
	if err != nil {
		s.internalError(w, "list server members", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": members})
}

func (s *Server) handleServerAddMember(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	member, err := s.store.AddGuildMember(r.Context(), guildMembership(r).GuildID, currentUser(r).ID, input.Username)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.AddUserGuild(member.UserID, member.GuildID)
	writeJSON(w, http.StatusCreated, map[string]any{"member": member})
}

func (s *Server) handleServerRemoveMember(w http.ResponseWriter, r *http.Request) {
	userID, ok := parsePathID(w, r, "userID")
	if !ok {
		return
	}
	if err := s.store.RemoveGuildMember(r.Context(), guildMembership(r).GuildID, currentUser(r).ID, userID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.RemoveUserGuild(userID, guildMembership(r).GuildID)
	s.hub.BroadcastGuild(guildMembership(r).GuildID, "server_removed", map[string]any{"userId": userID})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleServerMemberRole(w http.ResponseWriter, r *http.Request) {
	if guildMembership(r).Role != store.GuildRoleOwner && !currentUser(r).IsPlatformAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "只有所有者可以管理服务器管理员")
		return
	}
	userID, ok := parsePathID(w, r, "userID")
	if !ok {
		return
	}
	var input struct {
		Role store.GuildRole `json:"role"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	member, err := s.store.SetGuildMemberRole(r.Context(), guildMembership(r).GuildID, currentUser(r).ID, userID, input.Role)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"member": member})
}

func (s *Server) guildCanManageTarget(w http.ResponseWriter, r *http.Request, targetID int64, manageAdmins bool) bool {
	member, err := s.store.GuildMembership(r.Context(), guildMembership(r).GuildID, targetID)
	if err != nil {
		s.writeStoreError(w, err)
		return false
	}
	if member.Role == store.GuildRoleOwner || (!manageAdmins && member.Role == store.GuildRoleAdmin) {
		writeError(w, http.StatusForbidden, "forbidden", "无权管理该服务器成员")
		return false
	}
	return true
}

func (s *Server) handleServerMemberMute(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parsePathID(w, r, "userID")
	if !ok {
		return
	}
	if !s.guildCanManageTarget(w, r, targetID, currentUser(r).IsPlatformAdmin || guildMembership(r).Role == store.GuildRoleOwner) {
		return
	}
	var input struct {
		VoiceMuted bool `json:"voiceMuted"`
		TextMuted  bool `json:"textMuted"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	member, err := s.store.SetGuildMemberMute(r.Context(), guildMembership(r).GuildID, currentUser(r).ID, targetID, input.VoiceMuted, input.TextMuted)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"member": member})
}

func (s *Server) handleServerMemberBan(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parsePathID(w, r, "userID")
	if !ok {
		return
	}
	if !s.guildCanManageTarget(w, r, targetID, currentUser(r).IsPlatformAdmin || guildMembership(r).Role == store.GuildRoleOwner) {
		return
	}
	var input struct {
		Banned            bool       `json:"banned"`
		TemporaryBanUntil *time.Time `json:"temporaryBanUntil"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	member, err := s.store.SetGuildMemberBan(r.Context(), guildMembership(r).GuildID, currentUser(r).ID, targetID, input.Banned, input.TemporaryBanUntil)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if input.Banned || input.TemporaryBanUntil != nil {
		s.removeFromVoice(r, targetID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"member": member})
}

func (s *Server) handleServerClearTemporaryBan(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parsePathID(w, r, "userID")
	if !ok {
		return
	}
	if !s.guildCanManageTarget(w, r, targetID, currentUser(r).IsPlatformAdmin || guildMembership(r).Role == store.GuildRoleOwner) {
		return
	}
	member, err := s.store.ClearGuildMemberTemporaryBan(r.Context(), guildMembership(r).GuildID, currentUser(r).ID, targetID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"member": member})
}

func (s *Server) handleServerLeave(w http.ResponseWriter, r *http.Request) {
	member := guildMembership(r)
	if err := s.store.RemoveGuildMember(r.Context(), member.GuildID, currentUser(r).ID, currentUser(r).ID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleServerChannels(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Type store.ChannelType `json:"type"`
		Name string            `json:"name"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	channel, err := s.store.CreateGuildChannel(r.Context(), guildMembership(r).GuildID, currentUser(r).ID, input.Type, input.Name)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"channel": channel})
}

func (s *Server) handleServerUpdateChannel(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "channelID")
	if !ok {
		return
	}
	if _, err := s.store.GuildChannelByID(r.Context(), guildMembership(r).GuildID, channelID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	var input struct {
		Name                       string `json:"name"`
		AudioBitrateKbps           int    `json:"audioBitrateKbps"`
		BackgroundAudioBitrateKbps int    `json:"backgroundAudioBitrateKbps"`
		AudioRedEnabled            *bool  `json:"audioRedEnabled"`
		BackgroundAudioRedEnabled  *bool  `json:"backgroundAudioRedEnabled"`
		MessageRetention           int    `json:"messageRetention"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	audioRed, backgroundRed := true, false
	if input.AudioRedEnabled != nil {
		audioRed = *input.AudioRedEnabled
	}
	if input.BackgroundAudioRedEnabled != nil {
		backgroundRed = *input.BackgroundAudioRedEnabled
	}
	channel, err := s.store.UpdateChannel(r.Context(), currentUser(r).ID, channelID, input.Name, input.AudioBitrateKbps, input.BackgroundAudioBitrateKbps, audioRed, backgroundRed, input.MessageRetention)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channel": channel})
}

func (s *Server) handleServerDeleteChannel(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "channelID")
	if !ok {
		return
	}
	if _, err := s.store.GuildChannelByID(r.Context(), guildMembership(r).GuildID, channelID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	channel, err := s.store.DeleteChannel(r.Context(), currentUser(r).ID, channelID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channel": channel})
}

func (s *Server) handleServerMessages(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "channelID")
	if !ok {
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	messages, more, err := s.store.ListGuildChannelMessages(r.Context(), guildMembership(r).GuildID, channelID, before, limit)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": messages, "hasMore": more})
}

func (s *Server) handleServerCreateMessage(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "channelID")
	if !ok {
		return
	}
	if !s.allowMessage(currentUser(r).ID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "消息发送过快，请稍后再试")
		return
	}
	var input struct {
		Content string `json:"content"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	message, err := s.store.CreateGuildChannelMessage(r.Context(), guildMembership(r).GuildID, channelID, currentUser(r), input.Content)
	if err != nil {
		if err.Error() == "text muted" {
			writeError(w, http.StatusForbidden, "text_muted", "你已被文字禁言")
		} else {
			s.writeStoreError(w, err)
		}
		return
	}
	s.hub.BroadcastGuild(guildMembership(r).GuildID, "message_created", message)
	writeJSON(w, http.StatusCreated, map[string]any{"message": message})
}

func (s *Server) handleServerDeleteMessage(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "channelID")
	if !ok {
		return
	}
	messageID, ok := parsePathID(w, r, "messageID")
	if !ok {
		return
	}
	if _, err := s.store.GuildChannelByID(r.Context(), guildMembership(r).GuildID, channelID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	if err := s.store.DeleteChannelMessage(r.Context(), currentUser(r).ID, channelID, messageID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleServerRead(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "channelID")
	if !ok {
		return
	}
	if _, err := s.store.GuildChannelByID(r.Context(), guildMembership(r).GuildID, channelID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	state, err := s.store.MarkChannelRead(r.Context(), currentUser(r).ID, channelID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"readState": state})
}

func (s *Server) handleServerVoiceToken(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "channelID")
	if !ok {
		return
	}
	channel, err := s.store.GuildChannelByID(r.Context(), guildMembership(r).GuildID, channelID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if channel.Type != store.ChannelTypeVoice {
		writeError(w, http.StatusBadRequest, "invalid_channel_type", "该频道不是语音频道")
		return
	}
	credentials, err := s.media.JoinGuildCredentials(r.Context(), currentUser(r), guildMembership(r), channelID)
	if err != nil {
		s.internalError(w, "create server voice token", err)
		return
	}
	writeJSON(w, http.StatusOK, credentials)
}

func (s *Server) handleServerVoiceState(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "channelID")
	if !ok {
		return
	}
	if _, err := s.store.GuildChannelByID(r.Context(), guildMembership(r).GuildID, channelID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	var input struct {
		Deafened bool `json:"deafened"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := s.media.SetChannelDeafened(r.Context(), currentUser(r).ID, channelID, input.Deafened); err != nil {
		s.writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
