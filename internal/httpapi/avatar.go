package httpapi

import (
	"net/http"
	"strconv"
)

func (s *Server) handleUploadMyAvatar(w http.ResponseWriter, r *http.Request) {
	mime, buf, ok := readImageUpload(w, r)
	if !ok {
		return
	}
	user, err := s.store.SetAvatar(r.Context(), currentUser(r).ID, mime, buf)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastUser(user.ID, "user_updated", user)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) handleDeleteMyAvatar(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.ClearAvatar(r.Context(), currentUser(r).ID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastUser(user.ID, "user_updated", user)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) handleGetUserAvatar(w http.ResponseWriter, r *http.Request) {
	id, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	version, mime, avatarBytes, hasAvatar, err := s.store.GetAvatar(r.Context(), id)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if !hasAvatar || len(avatarBytes) == 0 {
		writeError(w, http.StatusNotFound, "avatar_not_found", "用户未设置头像")
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", strconv.FormatInt(int64(version), 10))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(avatarBytes)
}

func (s *Server) handleAdminDeleteAvatar(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	if targetID == currentUser(r).ID {
		writeError(w, http.StatusBadRequest, "avatar_admin_self", "不能在管理接口清除自己的头像")
		return
	}
	user, err := s.store.ClearAvatar(r.Context(), targetID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastUser(user.ID, "user_updated", user)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}