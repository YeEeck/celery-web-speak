package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/yeck/celery-web-speak/internal/media"
	"github.com/yeck/celery-web-speak/internal/store"
)

type guildContextKey int

const guildMembershipContextKey guildContextKey = iota

func guildIDFromRequest(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("guildID"), 10, 64)
	if err != nil || id < 1 {
		return 0, errors.New("invalid guild id")
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
				writeError(w, http.StatusForbidden, "guild_membership_required", "请先加入该服务器")
				return
			}
			writeError(w, http.StatusNotFound, "not_found", "服务器不存在")
			return
		}
		if member.PermanentlyBanned || (member.TemporaryBanUntil != nil && member.TemporaryBanUntil.After(time.Now())) {
			writeError(w, http.StatusForbidden, "guild_banned", "你当前无法访问该服务器")
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

func (s *Server) requirePlatformAdmin(next http.Handler) http.Handler {
	return s.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !currentUser(r).IsPlatformAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "需要平台管理员权限")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (s *Server) handlePlatformGuilds(w http.ResponseWriter, r *http.Request) {
	guilds, err := s.store.ListGuildsForUser(r.Context(), currentUser(r).ID, true)
	if err != nil {
		s.internalError(w, "list platform guilds", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"guilds": guilds})
}

func (s *Server) handlePlatformCreateGuild(w http.ResponseWriter, r *http.Request) {
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
	s.hub.AddUserGuild(guild.OwnerUserID, guild.ID)
	writeJSON(w, http.StatusCreated, map[string]any{"guild": guild})
}

func (s *Server) handlePlatformRenameGuild(w http.ResponseWriter, r *http.Request) {
	guildID, ok := parsePathID(w, r, "guildID")
	if !ok {
		return
	}
	s.renameGuild(w, r, guildID)
}

func (s *Server) handlePlatformJoinGuild(w http.ResponseWriter, r *http.Request) {
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
	if !member.ActiveAt(time.Now()) {
		s.writeStoreError(w, store.ErrGuildMemberBanned)
		return
	}
	s.hub.AddUserGuild(member.UserID, member.GuildID)
	writeJSON(w, http.StatusOK, map[string]any{"member": member})
}

func (s *Server) handlePlatformGuildOwner(w http.ResponseWriter, r *http.Request) {
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
	transfer, err := s.store.TransferGuildOwnership(r.Context(), guildID, currentUser(r).ID, input.UserID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastGuild(guildID, "guild_updated", transfer.Guild)
	s.hub.BroadcastGuild(guildID, "member_updated", transfer.PreviousOwner)
	if transfer.NewOwner.UserID != transfer.PreviousOwner.UserID {
		s.hub.BroadcastGuild(guildID, "member_updated", transfer.NewOwner)
	}
	writeJSON(w, http.StatusOK, map[string]any{"guild": transfer.Guild})
}

func (s *Server) handlePlatformDeleteGuild(w http.ResponseWriter, r *http.Request) {
	guildID, err := guildIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "服务器编号无效")
		return
	}
	channels, err := s.store.ListGuildChannels(r.Context(), guildID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if err := s.store.DeleteGuild(r.Context(), guildID, currentUser(r).ID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	if err := s.media.RemoveGuildParticipants(ctx, guildID); err != nil {
		s.logger.Warn("remove deleted guild voice participants", "guild_id", guildID, "error", err)
	}
	for _, channel := range channels {
		if channel.Type == store.ChannelTypeVoice {
			if err := s.media.DeleteGuildRoom(ctx, guildID, channel.ID); err != nil {
				s.logger.Warn("delete deleted guild voice room", "guild_id", guildID, "channel_id", channel.ID, "error", err)
			}
		}
	}
	cancel()
	s.hub.RemoveGuild(guildID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleGuildBootstrap(w http.ResponseWriter, r *http.Request) {
	guildID := guildMembership(r).GuildID
	channels, err := s.store.ListGuildChannels(r.Context(), guildID)
	if err != nil {
		s.internalError(w, "list guild channels", err)
		return
	}
	members, err := s.store.ListGuildMembers(r.Context(), guildID)
	if err != nil {
		s.internalError(w, "list guild members", err)
		return
	}
	readStates, err := s.store.ListChannelReadStates(r.Context(), currentUser(r).ID)
	if err != nil {
		s.internalError(w, "list guild read states", err)
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
	writeJSON(w, http.StatusOK, map[string]any{"guild": s.mustGuild(r, guildID), "membership": guildMembership(r), "members": members, "channels": channels, "channelReadStates": filteredRead, "online": s.hub.OnlineGuildClients(guildID), "voiceRooms": filteredVoice})
}

func (s *Server) mustGuild(r *http.Request, id int64) store.Guild {
	guild, _ := s.store.GuildByID(r.Context(), id)
	return guild
}

func (s *Server) handleGuildRename(w http.ResponseWriter, r *http.Request) {
	guildID := guildMembership(r).GuildID
	if guildMembership(r).Role != store.GuildRoleOwner && !currentUser(r).IsPlatformAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "只有服务器所有者可以重命名")
		return
	}
	s.renameGuild(w, r, guildID)
}

func (s *Server) renameGuild(w http.ResponseWriter, r *http.Request, guildID int64) {
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
	s.hub.BroadcastGuild(guildID, "guild_updated", guild)
	writeJSON(w, http.StatusOK, map[string]any{"guild": guild})
}

func (s *Server) handleGuildMembers(w http.ResponseWriter, r *http.Request) {
	members, err := s.store.ListGuildMembers(r.Context(), guildMembership(r).GuildID)
	if err != nil {
		s.internalError(w, "list guild members", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": members})
}

func (s *Server) handleGuildAddMember(w http.ResponseWriter, r *http.Request) {
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
	s.hub.BroadcastGuild(member.GuildID, "member_added", member)
	writeJSON(w, http.StatusCreated, map[string]any{"member": member})
}

func (s *Server) handleGuildRemoveMember(w http.ResponseWriter, r *http.Request) {
	userID, ok := parsePathID(w, r, "userID")
	if !ok {
		return
	}
	if userID == currentUser(r).ID {
		writeError(w, http.StatusBadRequest, "self_action", "请使用离开服务器操作")
		return
	}
	if !s.guildCanManageTarget(w, r, userID, currentUser(r).IsPlatformAdmin || guildMembership(r).Role == store.GuildRoleOwner) {
		return
	}
	guildID := guildMembership(r).GuildID
	if err := s.store.RemoveGuildMember(r.Context(), guildMembership(r).GuildID, currentUser(r).ID, userID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.RemoveUserGuild(userID, guildID)
	s.removeFromGuildVoice(r, guildID, userID)
	s.hub.BroadcastGuild(guildID, "member_removed", map[string]any{"userId": userID})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleGuildMemberRole(w http.ResponseWriter, r *http.Request) {
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
	s.hub.BroadcastGuild(guildMembership(r).GuildID, "member_updated", member)
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

func (s *Server) handleGuildMemberMute(w http.ResponseWriter, r *http.Request) {
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
	guildID := guildMembership(r).GuildID
	member, err := s.store.SetGuildMemberMute(r.Context(), guildID, currentUser(r).ID, targetID, input.VoiceMuted, input.TextMuted)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if err := s.media.SetGuildCanPublish(r.Context(), targetID, guildID, !input.VoiceMuted); err != nil {
		s.logger.Warn("sync guild voice mute", "guild_id", guildID, "user_id", targetID, "error", err)
	}
	s.hub.BroadcastGuild(guildID, "member_updated", member)
	writeJSON(w, http.StatusOK, map[string]any{"member": member})
}

func (s *Server) handleGuildMemberBan(w http.ResponseWriter, r *http.Request) {
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
	guildID := guildMembership(r).GuildID
	member, err := s.store.SetGuildMemberBan(r.Context(), guildID, currentUser(r).ID, targetID, input.Banned, input.TemporaryBanUntil)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if input.Banned || input.TemporaryBanUntil != nil {
		s.hub.RemoveUserGuild(targetID, guildID)
		s.removeFromGuildVoice(r, guildID, targetID)
		s.scheduleGuildMembershipRestore(input.TemporaryBanUntil)
	} else if member.ActiveAt(time.Now()) {
		s.hub.AddUserGuild(targetID, guildID)
	}
	s.hub.BroadcastGuild(guildID, "member_updated", member)
	writeJSON(w, http.StatusOK, map[string]any{"member": member})
}

func (s *Server) handleGuildClearTemporaryBan(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parsePathID(w, r, "userID")
	if !ok {
		return
	}
	if !s.guildCanManageTarget(w, r, targetID, currentUser(r).IsPlatformAdmin || guildMembership(r).Role == store.GuildRoleOwner) {
		return
	}
	guildID := guildMembership(r).GuildID
	member, err := s.store.ClearGuildMemberTemporaryBan(r.Context(), guildID, currentUser(r).ID, targetID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if member.ActiveAt(time.Now()) {
		s.hub.AddUserGuild(targetID, guildID)
	}
	s.hub.BroadcastGuild(guildID, "member_updated", member)
	writeJSON(w, http.StatusOK, map[string]any{"member": member})
}

func (s *Server) handleGuildLeave(w http.ResponseWriter, r *http.Request) {
	member := guildMembership(r)
	if err := s.store.RemoveGuildMember(r.Context(), member.GuildID, currentUser(r).ID, currentUser(r).ID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.RemoveUserGuild(currentUser(r).ID, member.GuildID)
	s.removeFromGuildVoice(r, member.GuildID, currentUser(r).ID)
	s.hub.BroadcastGuild(member.GuildID, "member_removed", map[string]any{"userId": currentUser(r).ID})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleGuildChannels(w http.ResponseWriter, r *http.Request) {
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
	s.hub.BroadcastGuild(channel.GuildID, "channel_created", channel)
	writeJSON(w, http.StatusCreated, map[string]any{"channel": channel})
}

func (s *Server) handleGuildUpdateChannel(w http.ResponseWriter, r *http.Request) {
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
	channel, err := s.store.UpdateGuildChannel(r.Context(), guildMembership(r).GuildID, currentUser(r).ID, channelID, input.Name, input.AudioBitrateKbps, input.BackgroundAudioBitrateKbps, audioRed, backgroundRed, input.MessageRetention)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastGuild(channel.GuildID, "channel_updated", channel)
	writeJSON(w, http.StatusOK, map[string]any{"channel": channel})
}

func (s *Server) handleGuildDeleteChannel(w http.ResponseWriter, r *http.Request) {
	channelID, ok := parsePathID(w, r, "channelID")
	if !ok {
		return
	}
	if _, err := s.store.GuildChannelByID(r.Context(), guildMembership(r).GuildID, channelID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	channel, err := s.store.DeleteGuildChannel(r.Context(), guildMembership(r).GuildID, currentUser(r).ID, channelID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if channel.Type == store.ChannelTypeVoice {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		if err := s.media.DeleteGuildRoom(ctx, channel.GuildID, channel.ID); err != nil {
			s.logger.Warn("delete guild voice room", "guild_id", channel.GuildID, "channel_id", channel.ID, "error", err)
		}
		cancel()
	}
	s.hub.BroadcastGuild(channel.GuildID, "channel_deleted", map[string]any{"id": channel.ID, "type": channel.Type})
	writeJSON(w, http.StatusOK, map[string]any{"channel": channel})
}

func (s *Server) handleGuildMessages(w http.ResponseWriter, r *http.Request) {
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

func (s *Server) handleGuildCreateMessage(w http.ResponseWriter, r *http.Request) {
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

func (s *Server) handleGuildDeleteMessage(w http.ResponseWriter, r *http.Request) {
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
	if err := s.store.DeleteGuildChannelMessage(r.Context(), guildMembership(r).GuildID, currentUser(r).ID, channelID, messageID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastGuild(guildMembership(r).GuildID, "message_deleted", map[string]int64{"channelId": channelID, "id": messageID})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleGuildRead(w http.ResponseWriter, r *http.Request) {
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
	s.hub.BroadcastGuild(guildMembership(r).GuildID, "channel_read", map[string]any{"userId": currentUser(r).ID, "readState": state})
	writeJSON(w, http.StatusOK, map[string]any{"readState": state})
}

func (s *Server) handleGuildVoiceToken(w http.ResponseWriter, r *http.Request) {
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
	var input struct {
		Deafened bool `json:"deafened"`
	}
	if r.ContentLength != 0 && !decodeJSON(w, r, &input) {
		return
	}
	credentials, err := s.media.JoinGuildCredentials(r.Context(), currentUser(r), guildMembership(r), channelID, input.Deafened)
	if err != nil {
		s.internalError(w, "create guild voice token", err)
		return
	}
	writeJSON(w, http.StatusOK, credentials)
}

func (s *Server) handleGuildVoiceState(w http.ResponseWriter, r *http.Request) {
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

func (s *Server) handleGuildVoiceParticipantDisconnect(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parsePathID(w, r, "userID")
	if !ok {
		return
	}
	if targetID == currentUser(r).ID {
		s.writeStoreError(w, store.ErrSelfAction)
		return
	}
	if !s.guildCanManageTarget(w, r, targetID, currentUser(r).IsPlatformAdmin || guildMembership(r).Role == store.GuildRoleOwner) {
		return
	}
	channelID, ok := parsePathID(w, r, "channelID")
	if !ok {
		return
	}
	guildID := guildMembership(r).GuildID
	channel, err := s.store.GuildChannelByID(r.Context(), guildID, channelID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if channel.Type != store.ChannelTypeVoice {
		writeError(w, http.StatusBadRequest, "voice_channel_required", "目标不是语音频道")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	err = s.media.RemoveParticipantFromChannel(ctx, targetID, guildID, channelID)
	cancel()
	if errors.Is(err, media.ErrParticipantNotInVoiceChannel) {
		writeError(w, http.StatusConflict, "voice_participant_not_in_channel", "该参与者已不在此语音频道")
		return
	}
	if err != nil {
		s.internalError(w, "disconnect guild voice participant", err)
		return
	}
	if err := s.store.RecordGuildVoiceDisconnect(r.Context(), guildID, currentUser(r).ID, targetID, channelID); err != nil {
		s.internalError(w, "record guild voice disconnect", err)
		return
	}
	s.hub.SendUser(targetID, "voice_disconnected_by_moderator", map[string]int64{"guildId": guildID, "channelId": channelID})
	s.broadcastVoiceRooms(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleGuildVoiceLeave(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	guildID := guildMembership(r).GuildID
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	err := s.media.RemoveParticipantFromGuild(ctx, user.ID, guildID)
	cancel()
	if err != nil {
		s.logger.Warn("remove guild voice participant on leave", "guild_id", guildID, "user_id", user.ID, "error", err)
	}
	s.broadcastVoiceRooms(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) removeFromGuildVoice(r *http.Request, guildID, userID int64) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.media.RemoveParticipantFromGuild(ctx, userID, guildID); err != nil {
		s.logger.Warn("remove guild voice participant", "guild_id", guildID, "user_id", userID, "error", err)
	}
	s.broadcastVoiceRooms(ctx)
}
