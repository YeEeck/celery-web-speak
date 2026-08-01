package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/yeck/celery-web-speak/internal/config"
	"github.com/yeck/celery-web-speak/internal/store"
)

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	user, err := s.store.Authenticate(r.Context(), input.Username, input.Password)
	if err != nil {
		if errors.Is(err, store.ErrBanned) {
			writeError(w, http.StatusForbidden, "banned", "账号当前无法进入")
		} else {
			writeError(w, http.StatusUnauthorized, "invalid_login", "用户名或密码错误")
		}
		return
	}
	s.startSession(w, r, user)
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var input struct {
		InviteCode  string `json:"inviteCode"`
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
		Password    string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	user, err := s.store.Register(r.Context(), input.InviteCode, input.Username, input.DisplayName, input.Password)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.startSession(w, r, user)
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, user store.User) {
	token, expiresAt, err := s.store.CreateSession(r.Context(), user.ID, s.cfg.SessionTTL)
	if err != nil {
		s.logger.Error("create session", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "无法创建登录会话")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     s.cfg.CookieName,
		Value:    token,
		Path:     "/",
		Expires:  expiresAt,
		MaxAge:   int(s.cfg.SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(s.cfg.CookieName); err == nil {
		_ = s.store.DeleteSession(r.Context(), cookie.Value)
	}
	clearCookie(w, s.cfg)
	w.WriteHeader(http.StatusNoContent)
}

func clearCookie(w http.ResponseWriter, cfg config.Config) {
	http.SetCookie(w, &http.Cookie{
		Name:     cfg.CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(1, 0),
		HttpOnly: true,
		Secure:   cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"user": currentUser(r)})
}

func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	var input struct {
		DisplayName     string `json:"displayName"`
		Bio             string `json:"bio"`
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	user, err := s.store.UpdateProfile(r.Context(), currentUser(r).ID, input.DisplayName, input.Bio, input.CurrentPassword, input.NewPassword)
	if err != nil {
		if errors.Is(err, store.ErrInvalidLogin) {
			writeError(w, http.StatusBadRequest, "invalid_password", "当前密码不正确")
		} else {
			s.writeStoreError(w, err)
		}
		return
	}
	if err := s.media.UpdateName(r.Context(), user.ID, user.DisplayName); err != nil {
		s.logger.Warn("update livekit participant name", "user_id", user.ID, "error", err)
	}
	s.hub.BroadcastUser(user.ID, "user_updated", user)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

// handleUpdateMyStatus persists the current user's status setting (自动模式 /
// 固定离开) and broadcasts the change so every connected client sees the
// updated presence. Only the account owner can modify it.
func (s *Server) handleUpdateMyStatus(w http.ResponseWriter, r *http.Request) {
	var input struct {
		FixedAway bool `json:"fixedAway"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	user := currentUser(r)
	if err := s.store.SetUserFixedAway(r.Context(), user.ID, input.FixedAway); err != nil {
		s.writeStoreError(w, err)
		return
	}
	user.FixedAway = input.FixedAway
	s.hub.SetUserFixedAway(user.ID, input.FixedAway)
	s.hub.BroadcastUser(user.ID, "user_updated", user)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrUsernameExists):
		writeError(w, http.StatusConflict, "username_exists", "登录名已存在")
	case errors.Is(err, store.ErrInvalidInvite):
		writeError(w, http.StatusBadRequest, "invalid_invite", "邀请码无效、已过期或次数已用完")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "目标不存在")
	case errors.Is(err, store.ErrLastPlatformAdmin):
		writeError(w, http.StatusConflict, "last_platform_admin", "必须保留至少一名平台管理员")
	case errors.Is(err, store.ErrSelfAction):
		writeError(w, http.StatusBadRequest, "self_action", "不能对自己的账号执行此操作")
	case errors.Is(err, store.ErrUsernameConfirm):
		writeError(w, http.StatusBadRequest, "confirmation_mismatch", "输入的登录名与目标账号不一致")
	case errors.Is(err, store.ErrLastChannel):
		writeError(w, http.StatusConflict, "last_channel", "必须至少保留一个同类型频道")
	case errors.Is(err, store.ErrChannelLimit):
		writeError(w, http.StatusConflict, "channel_limit", "同类型频道数量已达到上限")
	case errors.Is(err, store.ErrChannelNameExists):
		writeError(w, http.StatusConflict, "channel_name_exists", "同类型频道名称已存在")
	case errors.Is(err, store.ErrGuildOwnerTransferRequired):
		writeError(w, http.StatusConflict, "guild_owner_transfer_required", "请先转让或删除该账号拥有的服务器")
	case errors.Is(err, store.ErrGuildMemberBanned):
		writeError(w, http.StatusConflict, "guild_member_banned", "账号当前已被该服务器封禁")
	case errors.Is(err, store.ErrMessageDeleteForbidden):
		writeError(w, http.StatusForbidden, "message_delete_forbidden", "只能删除自己发送的消息")
	case errors.Is(err, store.ErrGuildMemberVoiceXPForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "无权管理该服务器成员的语音经验")
	case errors.Is(err, store.ErrInvalidGuildMemberVoiceXP):
		writeError(w, http.StatusBadRequest, "invalid_voice_xp", "服务器语音经验必须是 0 到 1000000000 的整数")
	default:
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
	}
}
