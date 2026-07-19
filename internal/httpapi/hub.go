package httpapi

import (
	"encoding/json"
	"sync"

	"github.com/yeck/celery-web-speak/internal/store"
)

type event struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type client struct {
	user store.User
	send chan []byte
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*client]struct{}
	counts  map[int64]int
}

func NewHub() *Hub {
	return &Hub{clients: make(map[*client]struct{}), counts: make(map[int64]int)}
}

func (h *Hub) register(c *client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.counts[c.user.ID]++
	h.mu.Unlock()
	h.Broadcast("presence", h.OnlineUserIDs())
}

func (h *Hub) unregister(c *client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
		h.counts[c.user.ID]--
		if h.counts[c.user.ID] <= 0 {
			delete(h.counts, c.user.ID)
		}
	}
	h.mu.Unlock()
	h.Broadcast("presence", h.OnlineUserIDs())
}

func (h *Hub) OnlineUserIDs() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ids := make([]int64, 0, len(h.counts))
	for id := range h.counts {
		ids = append(ids, id)
	}
	return ids
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
