package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

func (s *Server) handleListInvites(w http.ResponseWriter, r *http.Request) {
	cursor, ok := decodeInviteCursor(r.URL.Query().Get("cursor"))
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_cursor", "邀请码分页位置无效")
		return
	}
	invites, next, err := s.store.ListInvites(r.Context(), cursor, 30)
	if err != nil {
		s.internalError(w, "list invites", err)
		return
	}
	if invites == nil {
		invites = []store.Invite{}
	}
	nextCursor := ""
	if next != nil {
		nextCursor = encodeInviteCursor(next)
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": invites, "hasMore": next != nil, "nextCursor": nextCursor})
}

type inviteCursorPayload struct {
	Active   bool      `json:"active"`
	SortTime time.Time `json:"sortTime"`
	ID       int64     `json:"id"`
}

func decodeInviteCursor(value string) (*store.InviteCursor, bool) {
	if value == "" {
		return nil, true
	}
	encoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, false
	}
	var payload inviteCursorPayload
	if err := json.Unmarshal(encoded, &payload); err != nil || payload.ID < 1 || payload.SortTime.IsZero() {
		return nil, false
	}
	return &store.InviteCursor{Active: payload.Active, SortTime: payload.SortTime, ID: payload.ID}, true
}

func encodeInviteCursor(cursor *store.InviteCursor) string {
	encoded, _ := json.Marshal(inviteCursorPayload{Active: cursor.Active, SortTime: cursor.SortTime, ID: cursor.ID})
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	var input struct {
		MaxUses   int       `json:"maxUses"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	invite, err := s.store.CreateInvite(r.Context(), currentUser(r).ID, input.MaxUses, input.ExpiresAt)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"invite": invite})
}

func (s *Server) handleRevokeInvite(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	if err := s.store.RevokeInvite(r.Context(), currentUser(r).ID, id); err != nil {
		s.writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteInvite(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteInvite(r.Context(), currentUser(r).ID, id); err != nil {
		s.writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username    string     `json:"username"`
		DisplayName string     `json:"displayName"`
		Password    string     `json:"password"`
		Role        store.Role `json:"role"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Role == "" {
		input.Role = store.RoleMember
	}
	user, err := s.store.CreateUser(r.Context(), input.Username, input.DisplayName, input.Password, input.Role)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.Broadcast("user_updated", user)
	writeJSON(w, http.StatusCreated, map[string]any{"user": user})
}

func (s *Server) handleSetMute(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parseID(w, r)
	if !ok {
		return
	}
	target, ok := s.authorizeModeration(w, r, targetID)
	if !ok {
		return
	}
	var input struct {
		VoiceMuted bool `json:"voiceMuted"`
		TextMuted  bool `json:"textMuted"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := s.store.SetMute(r.Context(), currentUser(r).ID, targetID, input.VoiceMuted, input.TextMuted); err != nil {
		s.writeStoreError(w, err)
		return
	}
	if target.VoiceMuted != input.VoiceMuted {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		err := s.media.SetCanPublish(ctx, targetID, !input.VoiceMuted)
		cancel()
		if err != nil {
			s.logger.Warn("sync livekit publish permission", "user_id", targetID, "error", err)
		}
	}
	updated, _ := s.store.UserByID(r.Context(), targetID)
	s.hub.Broadcast("user_updated", updated)
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (s *Server) handleSetRole(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parseID(w, r)
	if !ok {
		return
	}
	var input struct {
		Role store.Role `json:"role"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := s.store.SetRole(r.Context(), currentUser(r).ID, targetID, input.Role); err != nil {
		s.writeStoreError(w, err)
		return
	}
	updated, _ := s.store.UserByID(r.Context(), targetID)
	s.hub.Broadcast("user_updated", updated)
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parseID(w, r)
	if !ok {
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := s.store.ResetPassword(r.Context(), currentUser(r).ID, targetID, input.Password); err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.DisconnectUser(targetID)
	s.removeFromVoice(r, targetID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleKick(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parseID(w, r)
	if !ok {
		return
	}
	if _, ok := s.authorizeModeration(w, r, targetID); !ok {
		return
	}
	var input struct {
		Until  time.Time `json:"until"`
		Reason string    `json:"reason"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := s.store.SetTemporaryBan(r.Context(), currentUser(r).ID, targetID, input.Until, input.Reason); err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.DisconnectUser(targetID)
	s.removeFromVoice(r, targetID)
	s.hub.Broadcast("user_updated", map[string]any{"id": targetID, "temporaryBanUntil": input.Until})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleClearTemporaryBan(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parseID(w, r)
	if !ok {
		return
	}
	if _, ok := s.authorizeModeration(w, r, targetID); !ok {
		return
	}
	if err := s.store.ClearTemporaryBan(r.Context(), currentUser(r).ID, targetID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	updated, _ := s.store.UserByID(r.Context(), targetID)
	s.hub.Broadcast("user_updated", updated)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handlePermanentBan(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parseID(w, r)
	if !ok {
		return
	}
	if targetID == currentUser(r).ID {
		writeError(w, http.StatusBadRequest, "self_action", "不能封禁自己的账号")
		return
	}
	var input struct {
		Banned bool `json:"banned"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := s.store.SetPermanentBan(r.Context(), currentUser(r).ID, targetID, input.Banned); err != nil {
		s.writeStoreError(w, err)
		return
	}
	if input.Banned {
		s.hub.DisconnectUser(targetID)
		s.removeFromVoice(r, targetID)
	}
	updated, _ := s.store.UserByID(r.Context(), targetID)
	s.hub.Broadcast("user_updated", updated)
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parseID(w, r)
	if !ok {
		return
	}
	var input struct {
		Username string `json:"username"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := s.store.DeleteUser(r.Context(), currentUser(r).ID, targetID, input.Username); err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.DisconnectUser(targetID)
	s.removeFromVoice(r, targetID)
	s.hub.Broadcast("user_deleted", map[string]int64{"id": targetID})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) authorizeModeration(w http.ResponseWriter, r *http.Request, targetID int64) (store.User, bool) {
	actor := currentUser(r)
	if actor.ID == targetID {
		writeError(w, http.StatusBadRequest, "self_action", "不能对自己执行此操作")
		return store.User{}, false
	}
	target, err := s.store.UserByID(r.Context(), targetID)
	if err != nil {
		s.writeStoreError(w, err)
		return store.User{}, false
	}
	if actor.Role == store.RoleChannelAdmin && target.Role != store.RoleMember {
		writeError(w, http.StatusForbidden, "forbidden", "频道管理员只能管理普通成员")
		return store.User{}, false
	}
	return target, true
}

func (s *Server) removeFromVoice(r *http.Request, userID int64) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.media.RemoveParticipant(ctx, userID); err != nil {
		s.logger.Warn("remove livekit participant", "user_id", userID, "error", err)
	}
}
