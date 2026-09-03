package httpapi

import (
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

const (
	pokeWindow       = 10 * time.Second
	pokeInitiatorCap = 8
)

type pokeLimiter struct {
	mu    sync.Mutex
	now   func() time.Time
	pairs map[[2]int64]time.Time
	caps  map[int64][]time.Time
}

func newPokeLimiter() *pokeLimiter {
	return &pokeLimiter{
		now:   time.Now,
		pairs: make(map[[2]int64]time.Time),
		caps:  make(map[int64][]time.Time),
	}
}

// Allow records a successful poke when both the pair window and initiator
// cap have room. Failures must not call it.
func (l *pokeLimiter) Allow(actorID, targetID int64) bool {
	now := l.now()
	cutoff := now.Add(-pokeWindow)
	key := [2]int64{actorID, targetID}
	l.mu.Lock()
	defer l.mu.Unlock()
	if last, ok := l.pairs[key]; ok && last.After(cutoff) {
		return false
	}
	previous := l.caps[actorID]
	recent := previous[:0]
	for _, timestamp := range previous {
		if timestamp.After(cutoff) {
			recent = append(recent, timestamp)
		}
	}
	if len(recent) >= pokeInitiatorCap {
		l.caps[actorID] = recent
		return false
	}
	l.pairs[key] = now
	l.caps[actorID] = append(recent, now)
	return true
}

func (s *Server) handlePokeCreate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		TargetUserID int64 `json:"targetUserId"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	actor := currentUser(r)
	if input.TargetUserID == actor.ID {
		writeError(w, http.StatusForbidden, "poke_unavailable", "现在不能戳")
		return
	}
	target, err := s.store.UserByID(r.Context(), input.TargetUserID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusForbidden, "poke_unavailable", "现在不能戳")
			return
		}
		s.internalError(w, "load poke target", err)
		return
	}
	if target.PermanentlyBanned || target.SuspendedAt != nil {
		writeError(w, http.StatusForbidden, "poke_unavailable", "现在不能戳")
		return
	}
	shared, err := s.store.SharedActiveGuild(r.Context(), actor.ID, target.ID)
	if err != nil {
		s.internalError(w, "check shared active guild for poke", err)
		return
	}
	if !shared {
		writeError(w, http.StatusForbidden, "poke_unavailable", "现在不能戳")
		return
	}
	if !s.hub.IsOnline(target.ID) {
		writeError(w, http.StatusConflict, "poke_offline", "对方不在线")
		return
	}
	if !s.pokeLimiter.Allow(actor.ID, target.ID) {
		writeError(w, http.StatusTooManyRequests, "poke_rate_limited", "戳得太频繁")
		return
	}
	s.hub.SendUser(target.ID, "poke", map[string]any{
		"actorUserId": actor.ID,
		"displayName": actor.DisplayName,
	})
	w.WriteHeader(http.StatusNoContent)
}

type liveGuildMessage struct {
	store.Message
	PokeDispatched bool `json:"pokeDispatched,omitempty"`
}

func (s *Server) dispatchMentionPokes(actor store.User, mentions []store.MessageMention) []int64 {
	poked := make([]int64, 0)
	for _, mention := range mentions {
		if mention.UserID == actor.ID {
			continue
		}
		if !s.hub.IsOnline(mention.UserID) {
			continue
		}
		if !s.pokeLimiter.Allow(actor.ID, mention.UserID) {
			continue
		}
		s.hub.SendUser(mention.UserID, "poke", map[string]any{
			"actorUserId": actor.ID,
			"displayName": actor.DisplayName,
		})
		poked = append(poked, mention.UserID)
	}
	return poked
}

func (s *Server) broadcastMessageCreated(guildID int64, message store.Message, pokedUserIDs []int64) {
	for _, userID := range pokedUserIDs {
		s.hub.SendUserGuild(userID, guildID, "message_created", liveGuildMessage{
			Message:        message,
			PokeDispatched: true,
		})
	}
	s.hub.BroadcastGuildExcept(guildID, pokedUserIDs, "message_created", message)
}
