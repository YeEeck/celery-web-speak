package httpapi

import (
	"net/http"
	"time"
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
// membership with the target.
func (s *Server) handleGetUserProfile(w http.ResponseWriter, r *http.Request) {
	id, ok := parsePathID(w, r, "id")
	if !ok {
		return
	}
	requester := currentUser(r)
	if id != requester.ID {
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
	writeJSON(w, http.StatusOK, map[string]any{"profile": profile})
}
