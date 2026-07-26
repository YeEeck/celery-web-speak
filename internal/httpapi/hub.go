package httpapi

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

type event struct {
	Type    string `json:"type"`
	GuildID int64  `json:"guildId,omitempty"`
	Data    any    `json:"data"`
}

// ClientKind identifies the kind of client a WebSocket connection originates
// from. It is self-reported by the client and therefore untrusted; it must
// only be used for cosmetic display purposes.
type ClientKind string

const (
	ClientWeb      ClientKind = "web"
	ClientElectron ClientKind = "electron"
	ClientAndroid  ClientKind = "android"
)

// clientPriority ranks client kinds for display: a user connected from
// several clients at once is shown as the highest-priority one
// (electron > android > web).
func clientPriority(kind ClientKind) int {
	switch kind {
	case ClientElectron:
		return 3
	case ClientAndroid:
		return 2
	default:
		return 1
	}
}

// OnlineClient pairs an online user with the client kind they are shown as.
type OnlineClient struct {
	UserID int64      `json:"userId"`
	Client ClientKind `json:"client"`
}

type client struct {
	user       store.User
	guilds     map[int64]struct{}
	clientType ClientKind
	send       chan []byte
	presence   chan []byte
	done       chan struct{}
	doneOnce   sync.Once
	revoked    atomic.Bool
	lastActive atomic.Int64
}

type Hub struct {
	mu          sync.RWMutex
	presenceMu  sync.Mutex
	clients     map[*client]struct{}
	counts      map[int64]int
	kinds       map[int64]ClientKind
	memberships map[int64]map[int64]struct{}
	lease       time.Duration
	now         func() time.Time
	schedule    func(time.Duration, func())
}

func NewHub() *Hub {
	return newHub(presenceLeaseDuration)
}

func newHub(lease time.Duration) *Hub {
	return &Hub{
		clients:     make(map[*client]struct{}),
		counts:      make(map[int64]int),
		kinds:       make(map[int64]ClientKind),
		memberships: make(map[int64]map[int64]struct{}),
		lease:       lease,
		now:         time.Now,
		schedule: func(delay time.Duration, fn func()) {
			time.AfterFunc(delay, fn)
		},
	}
}

func newClient(user store.User) *client {
	c := &client{
		user:       user,
		guilds:     make(map[int64]struct{}),
		clientType: ClientWeb,
		send:       make(chan []byte, 64),
		presence:   make(chan []byte, 1),
		done:       make(chan struct{}),
	}
	return c
}

func (c *client) touch(now time.Time) {
	c.lastActive.Store(now.UnixNano())
}

func (c *client) stop() {
	c.doneOnce.Do(func() { close(c.done) })
}

func (c *client) revoke() {
	c.revoked.Store(true)
	c.stop()
}

func (h *Hub) register(c *client) {
	c.touch(h.now())
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.counts[c.user.ID]++
	if kind, ok := h.effectiveKindForUserLocked(c.user.ID); ok {
		h.kinds[c.user.ID] = kind
	}
	if len(c.guilds) > 0 {
		h.memberships[c.user.ID] = c.guilds
	}
	h.mu.Unlock()
	h.BroadcastPresence()
}

func (h *Hub) unregister(c *client, graceful bool) {
	h.mu.Lock()
	if _, ok := h.clients[c]; !ok {
		h.mu.Unlock()
		return
	}
	delete(h.clients, c)
	c.stop()
	if kind, ok := h.effectiveKindForUserLocked(c.user.ID); ok {
		h.kinds[c.user.ID] = kind
	}
	h.mu.Unlock()

	if graceful {
		h.expire(c)
		return
	}
	lastActive := time.Unix(0, c.lastActive.Load())
	delay := lastActive.Add(h.lease).Sub(h.now())
	if delay <= 0 {
		h.expire(c)
		return
	}
	h.schedule(delay, func() { h.expire(c) })

}

func (h *Hub) expire(c *client) {
	h.mu.Lock()
	h.counts[c.user.ID]--
	if h.counts[c.user.ID] <= 0 {
		delete(h.counts, c.user.ID)
		delete(h.kinds, c.user.ID)
		delete(h.memberships, c.user.ID)
	}
	h.mu.Unlock()
	h.BroadcastPresence()
}

func (h *Hub) OnlineClients() []OnlineClient {
	h.mu.RLock()
	defer h.mu.RUnlock()
	best := h.effectiveClientsLocked()
	out := make([]OnlineClient, 0, len(best))
	for id, kind := range best {
		out = append(out, OnlineClient{UserID: id, Client: kind})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserID < out[j].UserID })
	return out
}

func (h *Hub) OnlineGuildClients(guildID int64) []OnlineClient {
	h.mu.RLock()
	defer h.mu.RUnlock()
	best := h.effectiveClientsLocked()
	out := make([]OnlineClient, 0)
	for id, kind := range best {
		if _, ok := h.memberships[id][guildID]; ok {
			out = append(out, OnlineClient{UserID: id, Client: kind})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserID < out[j].UserID })
	return out
}

// effectiveClientsLocked returns the client kind each online user is shown
// as. It reads the maintained kinds map (kept in sync with counts) so that
// users within the lease grace period after an unexpected disconnect remain
// visible with their last known client kind.
func (h *Hub) effectiveClientsLocked() map[int64]ClientKind {
	best := make(map[int64]ClientKind, len(h.counts))
	for id := range h.counts {
		best[id] = h.kinds[id]
	}
	return best
}

// effectiveKindForUserLocked returns the highest-priority client kind among
// the user's active connections, and whether any active connection exists.
func (h *Hub) effectiveKindForUserLocked(userID int64) (ClientKind, bool) {
	var best ClientKind
	found := false
	for c := range h.clients {
		if c.user.ID != userID {
			continue
		}
		if !found || clientPriority(c.clientType) > clientPriority(best) {
			best = c.clientType
			found = true
		}
	}
	return best, found
}

func (h *Hub) BroadcastPresence() {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		clients := h.onlineClientsForClientLocked(c)
		payload, err := json.Marshal(event{Type: "presence", Data: clients})
		if err != nil {
			continue
		}
		select {
		case c.presence <- payload:
		default:
			select {
			case <-c.presence:
			default:
			}
			select {
			case c.presence <- payload:
			default:
			}
		}
	}
}

func (h *Hub) RunPresenceBroadcaster(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.BroadcastPresence()
		}
	}
}

func (h *Hub) Broadcast(eventType string, data any) {
	payload, err := json.Marshal(event{Type: eventType, Data: data})
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		select {
		case c.send <- payload:
		default:
			c.stop()
		}
	}
}

func (h *Hub) BroadcastGuild(guildID int64, eventType string, data any) {
	payload, err := json.Marshal(event{Type: eventType, GuildID: guildID, Data: data})
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if _, ok := c.guilds[guildID]; !ok {
			continue
		}
		select {
		case c.send <- payload:
		default:
			c.stop()
		}
	}
}

// BroadcastUser sends account changes only to the account's own connections
// and connections that share at least one subscribed guild with it.
func (h *Hub) BroadcastUser(userID int64, eventType string, data any) {
	payload, err := json.Marshal(event{Type: eventType, Data: data})
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	targetGuilds := h.memberships[userID]
	for c := range h.clients {
		if c.user.ID != userID && !guildSetsIntersect(c.guilds, targetGuilds) {
			continue
		}
		select {
		case c.send <- payload:
		default:
			c.stop()
		}
	}
}

func (h *Hub) SetClientGuilds(c *client, guildIDs []int64) {
	h.mu.Lock()
	c.guilds = make(map[int64]struct{}, len(guildIDs))
	for _, id := range guildIDs {
		c.guilds[id] = struct{}{}
	}
	if len(c.guilds) > 0 {
		h.memberships[c.user.ID] = c.guilds
	} else {
		delete(h.memberships, c.user.ID)
	}
	h.mu.Unlock()
	h.BroadcastPresence()
}

func (h *Hub) AddUserGuild(userID, guildID int64) {
	h.mu.Lock()
	if h.memberships[userID] == nil {
		h.memberships[userID] = make(map[int64]struct{})
	}
	h.memberships[userID][guildID] = struct{}{}
	for c := range h.clients {
		if c.user.ID != userID {
			continue
		}
		c.guilds[guildID] = struct{}{}
		payload, _ := json.Marshal(event{Type: "guild_added", GuildID: guildID, Data: map[string]any{"guildId": guildID}})
		select {
		case c.send <- payload:
		default:
			c.stop()
		}
	}
	h.mu.Unlock()
	h.BroadcastPresence()
}

func (h *Hub) RemoveUserGuild(userID, guildID int64) {
	h.mu.Lock()
	if guilds := h.memberships[userID]; guilds != nil {
		delete(guilds, guildID)
	}
	for c := range h.clients {
		if c.user.ID != userID {
			continue
		}
		delete(c.guilds, guildID)
		payload, _ := json.Marshal(event{Type: "guild_removed", GuildID: guildID, Data: map[string]any{"guildId": guildID}})
		select {
		case c.send <- payload:
		default:
			c.stop()
		}
	}
	h.mu.Unlock()
	h.BroadcastPresence()
}

// RemoveGuild removes a guild subscription from every connected member and
// sends a targeted guild_removed event. It is used when a guild is deleted.
func (h *Hub) RemoveGuild(guildID int64) {
	h.mu.Lock()
	for userID, guilds := range h.memberships {
		delete(guilds, guildID)
		if len(guilds) == 0 {
			delete(h.memberships, userID)
		}
	}
	for c := range h.clients {
		if _, ok := c.guilds[guildID]; !ok {
			continue
		}
		delete(c.guilds, guildID)
		payload, _ := json.Marshal(event{Type: "guild_removed", GuildID: guildID, Data: map[string]any{"guildId": guildID}})
		select {
		case c.send <- payload:
		default:
			c.stop()
		}
	}
	h.mu.Unlock()
	h.BroadcastPresence()
}

func guildSetsIntersect(first, second map[int64]struct{}) bool {
	if len(first) == 0 || len(second) == 0 {
		return false
	}
	if len(first) > len(second) {
		first, second = second, first
	}
	for guildID := range first {
		if _, ok := second[guildID]; ok {
			return true
		}
	}
	return false
}

func (h *Hub) onlineClientsForClientLocked(c *client) []OnlineClient {
	best := h.effectiveClientsLocked()
	out := make([]OnlineClient, 0, len(best))
	for id, kind := range best {
		for guildID := range c.guilds {
			if _, ok := h.memberships[id][guildID]; ok {
				out = append(out, OnlineClient{UserID: id, Client: kind})
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserID < out[j].UserID })
	return out
}

func (h *Hub) DisconnectUser(userID int64) {
	h.mu.Lock()
	payload, _ := json.Marshal(event{Type: "session_revoked", Data: map[string]any{"userId": userID}})
	for c := range h.clients {
		if c.user.ID != userID {
			continue
		}
		select {
		case c.send <- payload:
		default:
		}
		delete(h.clients, c)
		c.revoke()
	}
	delete(h.counts, userID)
	delete(h.kinds, userID)
	delete(h.memberships, userID)
	h.mu.Unlock()
	h.BroadcastPresence()
}
