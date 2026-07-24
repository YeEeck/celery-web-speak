package httpapi

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

func TestHubKeepsUserOnlineUntilLastConnectionCloses(t *testing.T) {
	hub := newHub(15 * time.Second)
	first := newClient(store.User{ID: 7})
	second := newClient(store.User{ID: 7})

	hub.register(first)
	hub.register(second)
	hub.unregister(first, true)
	assertOnlineUserIDs(t, hub, []int64{7})

	hub.unregister(second, true)
	assertOnlineUserIDs(t, hub, nil)
}

func TestHubUnexpectedDisconnectUsesRemainingLease(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	now := base
	hub := newHub(15 * time.Second)
	hub.now = func() time.Time { return now }
	var scheduledDelay time.Duration
	var expire func()
	hub.schedule = func(delay time.Duration, fn func()) {
		scheduledDelay = delay
		expire = fn
	}
	client := newClient(store.User{ID: 9})

	hub.register(client)
	now = base.Add(6 * time.Second)
	hub.unregister(client, false)

	if scheduledDelay != 9*time.Second {
		t.Fatalf("scheduled delay = %s, want 9s", scheduledDelay)
	}
	assertOnlineUserIDs(t, hub, []int64{9})
	expire()
	assertOnlineUserIDs(t, hub, nil)
}

func TestHubReconnectDuringLeaseDoesNotGoOffline(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	hub := newHub(15 * time.Second)
	hub.now = func() time.Time { return base }
	var expire func()
	hub.schedule = func(_ time.Duration, fn func()) { expire = fn }
	oldConnection := newClient(store.User{ID: 11})
	hub.register(oldConnection)
	hub.unregister(oldConnection, false)

	newConnection := newClient(store.User{ID: 11})
	hub.register(newConnection)
	expire()
	assertOnlineUserIDs(t, hub, []int64{11})

	hub.unregister(newConnection, true)
	assertOnlineUserIDs(t, hub, nil)
}

func TestHubPresenceSnapshotReplacesPendingValue(t *testing.T) {
	hub := newHub(15 * time.Second)
	observer := newClient(store.User{ID: 1})
	hub.register(observer)
	for range cap(observer.send) {
		observer.send <- []byte(`{"type":"message_created"}`)
	}

	second := newClient(store.User{ID: 2})
	third := newClient(store.User{ID: 3})
	hub.register(second)
	hub.register(third)

	if len(observer.send) != cap(observer.send) {
		t.Fatalf("ordinary event queue length = %d, want %d", len(observer.send), cap(observer.send))
	}
	assertPresenceSnapshot(t, observer, []int64{1, 2, 3})
}

func TestHubOrdinaryQueueOverflowStopsClient(t *testing.T) {
	hub := newHub(15 * time.Second)
	client := newClient(store.User{ID: 5})
	hub.register(client)
	for range cap(client.send) {
		client.send <- []byte(`{"type":"message_created"}`)
	}

	hub.Broadcast("channel_created", map[string]any{"id": 9})

	select {
	case <-client.done:
	case <-time.After(time.Second):
		t.Fatal("overflowed client was not stopped")
	}
}

func TestHubGuildBroadcastIsIsolated(t *testing.T) {
	hub := newHub(15 * time.Second)
	first := newClient(store.User{ID: 1})
	first.guilds[10] = struct{}{}
	second := newClient(store.User{ID: 2})
	second.guilds[20] = struct{}{}
	hub.register(first)
	hub.register(second)

	hub.BroadcastGuild(10, "message_created", map[string]int64{"id": 1})
	select {
	case <-first.send:
	case <-time.After(time.Second):
		t.Fatal("guild member did not receive event")
	}
	select {
	case <-second.send:
		t.Fatal("other guild received event")
	default:
	}
}

func TestHubGuildPresenceIsIsolated(t *testing.T) {
	hub := newHub(15 * time.Second)
	first := newClient(store.User{ID: 1})
	first.guilds[10] = struct{}{}
	shared := newClient(store.User{ID: 2})
	shared.guilds[10] = struct{}{}
	shared.guilds[20] = struct{}{}
	other := newClient(store.User{ID: 3})
	other.guilds[20] = struct{}{}
	hub.register(first)
	hub.register(shared)
	hub.register(other)
	if got := hub.OnlineGuildUserIDs(10); !slices.Equal(got, []int64{1, 2}) {
		t.Fatalf("guild 10 online IDs = %v", got)
	}
	if got := hub.OnlineGuildUserIDs(20); !slices.Equal(got, []int64{2, 3}) {
		t.Fatalf("guild 20 online IDs = %v", got)
	}
}

func TestHubPeriodicallyRebroadcastsPresence(t *testing.T) {
	hub := newHub(15 * time.Second)
	client := newClient(store.User{ID: 4})
	hub.register(client)
	assertPresenceSnapshot(t, client, []int64{4})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.RunPresenceBroadcaster(ctx, time.Millisecond)
	assertPresenceSnapshot(t, client, []int64{4})
}

func assertOnlineUserIDs(t *testing.T, hub *Hub, want []int64) {
	t.Helper()
	if got := hub.OnlineUserIDs(); !slices.Equal(got, want) {
		t.Fatalf("online user IDs = %v, want %v", got, want)
	}
}

func assertPresenceSnapshot(t *testing.T, client *client, want []int64) {
	t.Helper()
	select {
	case payload := <-client.presence:
		var got event
		if err := json.Unmarshal(payload, &got); err != nil {
			t.Fatalf("decode presence event: %v", err)
		}
		if got.Type != "presence" {
			t.Fatalf("event type = %q, want presence", got.Type)
		}
		data, err := json.Marshal(got.Data)
		if err != nil {
			t.Fatalf("encode presence data: %v", err)
		}
		var ids []int64
		if err := json.Unmarshal(data, &ids); err != nil {
			t.Fatalf("decode presence IDs: %v", err)
		}
		if !slices.Equal(ids, want) {
			t.Fatalf("presence IDs = %v, want %v", ids, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for presence snapshot")
	}
}
