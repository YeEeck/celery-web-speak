package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	guilds, err := s.store.ListGuildsForUser(r.Context(), currentUser(r).ID, currentUser(r).IsPlatformAdmin)
	if err != nil {
		s.internalError(w, "list guilds", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":   currentUser(r),
		"guilds": guilds,
	})
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

// handleGetUserProfile returns the global profile fields shown on a personal
// info card: display name, username, bio, platform online time and account
// creation time. It is readable only by users who share at least one guild
// membership with the target (platform admins bypass this). The optional
// guild_id query parameter narrows the authorization check to that specific
// guild and, when present, the response also carries the target's accumulated
// voice seconds, voice XP and level progress within that guild.
func (s *Server) handleGetUserProfile(w http.ResponseWriter, r *http.Request) {
	id, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	requester := currentUser(r)
	var guildID int64
	if raw := r.URL.Query().Get("guild_id"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 1 {
			writeError(w, http.StatusBadRequest, "invalid_guild_id", "服务器编号无效")
			return
		}
		guildID = parsed
	}
	var profile store.UserProfile
	var err error
	if guildID != 0 {
		profile, err = s.store.GuildProfileView(r.Context(), requester.ID, id, guildID)
		switch {
		case errors.Is(err, store.ErrNotGuildMember):
			writeError(w, http.StatusForbidden, "not_guild_member", "无法查看该用户在此服务器的资料")
			return
		case errors.Is(err, store.ErrNotFound):
			writeError(w, http.StatusNotFound, "not_found", "该用户不在此服务器")
			return
		case err != nil:
			s.internalError(w, "read guild profile", err)
			return
		}
	} else {
		profile, err = s.store.ProfileView(r.Context(), requester.ID, id, requester.IsPlatformAdmin)
		switch {
		case errors.Is(err, store.ErrProfileNotInSharedGuild):
			writeError(w, http.StatusForbidden, "not_in_shared_guild", "无法查看该用户的资料")
			return
		case err != nil:
			s.writeStoreError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": profile})
}
