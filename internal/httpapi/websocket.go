package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

const (
	webSocketPingInterval     = 5 * time.Second
	presenceLeaseDuration     = 15 * time.Second
	presenceBroadcastInterval = 15 * time.Second
	onlineTimeFlushInterval   = 60 * time.Second
	voiceRoomsRefreshMessage  = "refresh_voice_rooms"
)

type webSocketControlMessage struct {
	Type string `json:"type"`
}

// parseClientKind reads the self-reported client kind from the WebSocket
// query string. The value is untrusted and only used for display; unknown or
// missing values are normalized to web.
func parseClientKind(r *http.Request) ClientKind {
	switch r.URL.Query().Get("client") {
	case string(ClientElectron):
		return ClientElectron
	case string(ClientAndroid):
		return ClientAndroid
	default:
		return ClientWeb
	}
}

func (s *Server) RunPresenceBroadcaster(ctx context.Context) {
	s.hub.RunPresenceBroadcaster(ctx, presenceBroadcastInterval)
}

func (s *Server) RunOnlineTimeFlusher(ctx context.Context) {
	s.hub.RunOnlineTimeFlusher(ctx, onlineTimeFlushInterval)
}

// FlushOnlineTime settles every in-flight presence segment. Called during
// graceful shutdown so segments still open at exit are persisted.
func (s *Server) FlushOnlineTime() {
	s.hub.FlushOnlineTime()
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := newClient(currentUser(r))
	c.clientType = parseClientKind(r)
	guilds, err := s.store.ListGuildsForUser(r.Context(), c.user.ID, false)
	if err == nil {
		ids := make([]int64, 0, len(guilds))
		for _, guild := range guilds {
			if guild.Joined {
				ids = append(ids, guild.ID)
			}
		}
		c.guilds = make(map[int64]struct{}, len(ids))
		for _, id := range ids {
			c.guilds[id] = struct{}{}
		}
	}
	s.hub.register(c)
	go s.reconcileVoiceRooms(context.Background(), "websocket_connect")

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.writeWebSocket(conn, c)
	}()

	conn.SetReadLimit(1024)
	_ = conn.SetReadDeadline(time.Now().Add(presenceLeaseDuration))
	conn.SetPongHandler(func(string) error {
		now := time.Now()
		c.touch(now)
		return conn.SetReadDeadline(now.Add(presenceLeaseDuration))
	})
	var readErr error
	for {
		var payload []byte
		if _, payload, readErr = conn.ReadMessage(); readErr != nil {
			break
		}
		s.handleWebSocketControlMessage(payload)
	}
	s.hub.unregister(c, isGracefulWebSocketClose(readErr))
	_ = conn.Close()
	<-done
}

func (s *Server) handleWebSocketControlMessage(payload []byte) {
	var message webSocketControlMessage
	if json.Unmarshal(payload, &message) != nil {
		return
	}
	if message.Type == voiceRoomsRefreshMessage {
		s.scheduleVoiceRoomRefresh("client_event")
	}
}

func isGracefulWebSocketClose(err error) bool {
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) {
		return false
	}
	return closeErr.Code == websocket.CloseNormalClosure ||
		closeErr.Code == websocket.CloseGoingAway ||
		closeErr.Code == websocket.CloseNoStatusReceived
}

func (s *Server) writeWebSocket(conn *websocket.Conn, c *client) {
	defer conn.Close()
	ticker := time.NewTicker(webSocketPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			code := websocket.CloseTryAgainLater
			reason := "event queue overflow"
			if c.revoked.Load() {
				code = websocket.ClosePolicyViolation
				reason = "session revoked"
			}
			_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason))
			return
		case payload := <-c.presence:
			if !writeWebSocketMessage(conn, payload) {
				return
			}
		case payload, ok := <-c.send:
			if !ok || payload == nil {
				_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "session revoked"))
				return
			}
			if !writeWebSocketMessage(conn, payload) {
				return
			}
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func writeWebSocketMessage(conn *websocket.Conn, payload []byte) bool {
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.WriteMessage(websocket.TextMessage, payload) == nil
}
