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
	Type string `json:"type"`
	Data any    `json:"data"`
}

type client struct {
	user       store.User
	send       chan []byte
	presence   chan []byte
	done       chan struct{}
	lastActive atomic.Int64
}

type Hub struct {
	mu         sync.RWMutex
	presenceMu sync.Mutex
	clients    map[*client]struct{}
	counts     map[int64]int
	lease      time.Duration
	now        func() time.Time
	schedule   func(time.Duration, func())
}

func NewHub() *Hub {
	return newHub(presenceLeaseDuration)
}

func newHub(lease time.Duration) *Hub {
	return &Hub{
		clients: make(map[*client]struct{}),
		counts:  make(map[int64]int),
		lease:   lease,
		now:     time.Now,
		schedule: func(delay time.Duration, fn func()) {
			time.AfterFunc(delay, fn)
		},
	}
}

func newClient(user store.User) *client {
	c := &client{
		user:     user,
		send:     make(chan []byte, 64),
		presence: make(chan []byte, 1),
		done:     make(chan struct{}),
	}
	return c
}

func (c *client) touch(now time.Time) {
	c.lastActive.Store(now.UnixNano())
}

func (h *Hub) register(c *client) {
	c.touch(h.now())
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.counts[c.user.ID]++
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
	close(c.done)
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

func (h *Hub) BroadcastPresence() {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	payload, err := json.Marshal(event{Type: "presence", Data: h.OnlineUserIDs()})
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
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
			// The connection writer closes clients that cannot keep up.
		}
	}
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
