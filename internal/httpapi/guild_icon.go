package httpapi

import (
	"net/http"
	"strconv"
)

func (s *Server) handleUploadGuildIcon(w http.ResponseWriter, r *http.Request) {
	mime, buf, ok := readImageUpload(w, r)
	if !ok {
		return
	}
	guildID := guildMembership(r).GuildID
	guild, err := s.store.SetGuildIcon(r.Context(), guildID, currentUser(r).ID, mime, buf)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastGuild(guildID, "guild_updated", guild)
	writeJSON(w, http.StatusOK, map[string]any{"guild": guild})
}

func (s *Server) handleDeleteGuildIcon(w http.ResponseWriter, r *http.Request) {
	guildID := guildMembership(r).GuildID
	guild, err := s.store.ClearGuildIcon(r.Context(), guildID, currentUser(r).ID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastGuild(guildID, "guild_updated", guild)
	writeJSON(w, http.StatusOK, map[string]any{"guild": guild})
}

func (s *Server) handleGetGuildIcon(w http.ResponseWriter, r *http.Request) {
	guildID, err := guildIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "服务器编号无效")
		return
	}
	version, mime, iconBytes, hasIcon, err := s.store.GetGuildIcon(r.Context(), guildID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if !hasIcon || len(iconBytes) == 0 {
		writeError(w, http.StatusNotFound, "icon_not_found", "服务器未设置图标")
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", strconv.FormatInt(int64(version), 10))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(iconBytes)
}

func (s *Server) handlePlatformUploadGuildIcon(w http.ResponseWriter, r *http.Request) {
	guildID, ok := parsePathID(w, r, "guildID")
	if !ok {
		return
	}
	mime, buf, ok := readImageUpload(w, r)
	if !ok {
		return
	}
	guild, err := s.store.SetGuildIcon(r.Context(), guildID, currentUser(r).ID, mime, buf)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastGuild(guildID, "guild_updated", guild)
	writeJSON(w, http.StatusOK, map[string]any{"guild": guild})
}

func (s *Server) handlePlatformDeleteGuildIcon(w http.ResponseWriter, r *http.Request) {
	guildID, ok := parsePathID(w, r, "guildID")
	if !ok {
		return
	}
	guild, err := s.store.ClearGuildIcon(r.Context(), guildID, currentUser(r).ID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.hub.BroadcastGuild(guildID, "guild_updated", guild)
	writeJSON(w, http.StatusOK, map[string]any{"guild": guild})
}