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
		"user":    currentUser(r),
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
// membership with the target. The optional guild_id query parameter narrows
// the shared-guild check to that specific guild and, when present, the
// response also carries the target's accumulated voice seconds within that
// guild.
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
	if guildID != 0 {
		// Narrow the authorization check to the requested guild: the requester
		// must be a member of that guild, so the leaked voice time pertains to
		// a server they already belong to. (Self bypass is implicit: if the
		// requester is in the guild, so is the target when id == requester.ID.)
		if _, err := s.store.GuildMembership(r.Context(), guildID, requester.ID); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusForbidden, "not_guild_member", "无法查看该用户在此服务器的资料")
				return
			}
			s.internalError(w, "check requester guild membership", err)
			return
		}
		// For non-self targets, the target must also be a member of that
		// guild, otherwise their voice seconds there are not derivable.
		if id != requester.ID {
			if _, err := s.store.GuildMembership(r.Context(), guildID, id); err != nil {
				if errors.Is(err, store.ErrNotFound) {
					writeError(w, http.StatusForbidden, "target_not_guild_member", "该用户不在此服务器")
					return
				}
				s.internalError(w, "check target guild membership", err)
				return
			}
		}
	} else if id != requester.ID {
		shared, err := s.store.SharedGuild(r.Context(), requester.ID, id)
		if err != nil {
			s.internalError(w, "check shared guild", err)
			return
		}
		if !shared && !requester.IsPlatformAdmin {
			writeError(w, http.StatusForbidden, "not_in_shared_guild", "无法查看该用户的资料")
			return
		}
	}
	profile, err := s.store.UserProfile(r.Context(), id)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if guildID != 0 {
		seconds, err := s.store.GuildMemberVoiceSeconds(r.Context(), guildID, id)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				seconds = 0
			} else {
				s.internalError(w, "read guild voice seconds", err)
				return
			}
		}
		profile.VoiceSecondsTotal = &seconds
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": profile})
}
