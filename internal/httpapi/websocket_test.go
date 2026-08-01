package httpapi

import (
	"errors"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/yeck/celery-web-speak/internal/store"
)

func TestGracefulWebSocketClose(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "normal", err: &websocket.CloseError{Code: websocket.CloseNormalClosure}, want: true},
		{name: "browser going away", err: &websocket.CloseError{Code: websocket.CloseGoingAway}, want: true},
		{name: "close without status", err: &websocket.CloseError{Code: websocket.CloseNoStatusReceived}, want: true},
		{name: "abnormal", err: &websocket.CloseError{Code: websocket.CloseAbnormalClosure}, want: false},
		{name: "network error", err: errors.New("connection reset"), want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isGracefulWebSocketClose(test.err); got != test.want {
				t.Fatalf("isGracefulWebSocketClose() = %t, want %t", got, test.want)
			}
		})
	}
}

func TestDeviceStatusControlMessage(t *testing.T) {
	_, admin, server := newGuildHTTPTestServer(t)
	c := newClient(store.User{ID: admin.ID})
	server.hub.register(c)

	server.handleWebSocketControlMessage(c, []byte(`{"type":"device_status","status":"away"}`))
	assertOnlineClients(t, server.hub, []OnlineClient{{UserID: admin.ID, Client: ClientWeb, Status: PresenceAway}})

	server.handleWebSocketControlMessage(c, []byte(`{"type":"device_status","status":"online"}`))
	assertOnlineClients(t, server.hub, []OnlineClient{{UserID: admin.ID, Client: ClientWeb, Status: PresenceOnline}})

	server.handleWebSocketControlMessage(c, []byte(`{"type":"device_status","status":"busy"}`))
	assertOnlineClients(t, server.hub, []OnlineClient{{UserID: admin.ID, Client: ClientWeb, Status: PresenceOnline}})

	server.handleWebSocketControlMessage(c, []byte(`not json`))
	assertOnlineClients(t, server.hub, []OnlineClient{{UserID: admin.ID, Client: ClientWeb, Status: PresenceOnline}})
}
