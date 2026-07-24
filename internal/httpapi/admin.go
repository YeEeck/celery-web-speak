package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

func (s *Server) handlePlatformUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		s.internalError(w, "list platform users", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (s *Server) handlePlatformSuspend(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parseID(w, r)
	if !ok {
		return
	}
	var input struct {
		Suspended bool `json:"suspended"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := s.store.SetPermanentBan(r.Context(), currentUser(r).ID, targetID, input.Suspended); err != nil {
		s.writeStoreError(w, err)
		return
	}
	if input.Suspended {
		s.hub.DisconnectUser(targetID)
		s.removeFromVoice(r, targetID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"suspended": input.Suspended})
}

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

func (s *Server) handlePlatformCreateUser(w http.ResponseWriter, r *http.Request) {
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
	if input.Role != store.RoleMember && input.Role != store.RolePlatformAdmin {
		writeError(w, http.StatusBadRequest, "invalid_platform_role", "平台角色只能是普通账号或平台管理员")
		return
	}
	user, err := s.store.CreateUser(r.Context(), input.Username, input.DisplayName, input.Password, input.Role)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastUser(user.ID, "user_updated", user)
	writeJSON(w, http.StatusCreated, map[string]any{"user": user})
}

func (s *Server) handleSetPlatformRole(w http.ResponseWriter, r *http.Request) {
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
	if input.Role != store.RoleMember && input.Role != store.RolePlatformAdmin {
		writeError(w, http.StatusBadRequest, "invalid_platform_role", "平台角色只能是普通账号或平台管理员")
		return
	}
	if err := s.store.SetRole(r.Context(), currentUser(r).ID, targetID, input.Role); err != nil {
		s.writeStoreError(w, err)
		return
	}
	updated, _ := s.store.UserByID(r.Context(), targetID)
	s.hub.BroadcastUser(targetID, "user_updated", updated)
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
	s.hub.BroadcastUser(targetID, "user_deleted", map[string]int64{"id": targetID})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) removeFromVoice(r *http.Request, userID int64) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.media.RemoveParticipant(ctx, userID); err != nil {
		s.logger.Warn("remove livekit participant", "user_id", userID, "error", err)
	}
}
