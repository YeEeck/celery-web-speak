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
	Type     string `json:"type"`
	ServerID int64  `json:"serverId,omitempty"`
	Data     any    `json:"data"`
}

type client struct {
	user       store.User
	guilds     map[int64]struct{}
	send       chan []byte
	presence   chan []byte
	done       chan struct{}
	doneOnce   sync.Once
	lastActive atomic.Int64
}

type Hub struct {
	mu          sync.RWMutex
	presenceMu  sync.Mutex
	clients     map[*client]struct{}
	counts      map[int64]int
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
		user:     user,
		guilds:   make(map[int64]struct{}),
		send:     make(chan []byte, 64),
		presence: make(chan []byte, 1),
		done:     make(chan struct{}),
	}
	return c
}

func (c *client) touch(now time.Time) {
	c.lastActive.Store(now.UnixNano())
}

func (c *client) stop() {
	c.doneOnce.Do(func() { close(c.done) })
}

func (h *Hub) register(c *client) {
	c.touch(h.now())
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.counts[c.user.ID]++
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
		delete(h.memberships, c.user.ID)
	}
	h.mu.Unlock()
	h.BroadcastPresence()
}

func (h *Hub) OnlineUserIDs() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ids := make([]int64, 0, len(h.counts))
	for id := range h.counts {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func (h *Hub) OnlineGuildUserIDs(guildID int64) []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ids := make([]int64, 0)
	for userID := range h.counts {
		if _, ok := h.memberships[userID][guildID]; ok {
			ids = append(ids, userID)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func (h *Hub) BroadcastPresence() {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		ids := h.onlineIDsForGuildLocked(c)
		payload, err := json.Marshal(event{Type: "presence", Data: ids})
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
	payload, err := json.Marshal(event{Type: eventType, ServerID: guildID, Data: data})
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
// and connections that share at least one subscribed server with it.
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
		payload, _ := json.Marshal(event{Type: "server_added", ServerID: guildID, Data: map[string]any{"serverId": guildID}})
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
		payload, _ := json.Marshal(event{Type: "server_removed", ServerID: guildID, Data: map[string]any{"serverId": guildID}})
		select {
		case c.send <- payload:
		default:
			c.stop()
		}
	}
	h.mu.Unlock()
	h.BroadcastPresence()
}

// RemoveGuild removes a server subscription from every connected member and
// sends a targeted server_removed event. It is used when a server is deleted.
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
		payload, _ := json.Marshal(event{Type: "server_removed", ServerID: guildID, Data: map[string]any{"serverId": guildID}})
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

func (h *Hub) onlineIDsForGuildLocked(c *client) []int64 {
	ids := make([]int64, 0, len(h.counts))
	for id := range h.counts {
		for guildID := range c.guilds {
			if _, ok := h.memberships[id][guildID]; ok {
				ids = append(ids, id)
				break
			}
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func (h *Hub) onlineIDsLocked() []int64 {
	ids := make([]int64, 0, len(h.counts))
	for id := range h.counts {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func (h *Hub) DisconnectUser(userID int64) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	payload, _ := json.Marshal(event{Type: "session_revoked", Data: map[string]any{"userId": userID}})
	for c := range h.clients {
		if c.user.ID == userID {
			select {
			case c.send <- payload:
			default:
			}
		}
	}
}
