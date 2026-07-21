package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

const (
	webSocketPingInterval     = 5 * time.Second
	presenceLeaseDuration     = 15 * time.Second
	presenceBroadcastInterval = 15 * time.Second
)

func (s *Server) RunPresenceBroadcaster(ctx context.Context) {
	s.hub.RunPresenceBroadcaster(ctx, presenceBroadcastInterval)
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := newClient(currentUser(r))
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
		if _, _, readErr = conn.ReadMessage(); readErr != nil {
			break
		}
	}
	s.hub.unregister(c, isGracefulWebSocketClose(readErr))
	_ = conn.Close()
	<-done
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
