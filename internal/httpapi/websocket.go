package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &client{user: currentUser(r), send: make(chan []byte, 64)}
	s.hub.register(c)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := s.media.Refresh(ctx); err != nil {
			s.logger.Warn("refresh livekit rooms after websocket connect", "error", err)
			return
		}
		s.hub.Broadcast("voice_rooms", s.media.VoiceRooms())
	}()
	defer func() {
		s.hub.unregister(c)
		_ = conn.Close()
	}()

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.writeWebSocket(conn, c)
	}()

	conn.SetReadLimit(1024)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	})
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
	<-done
}

func (s *Server) writeWebSocket(conn *websocket.Conn, c *client) {
	defer conn.Close()
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case payload, ok := <-c.send:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok || payload == nil {
				_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "session revoked"))
				return
			}
			if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
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
