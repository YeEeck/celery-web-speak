package httpapi

import (
	"context"
	"encoding/json"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

type fakePresenceSink struct {
	mu     sync.Mutex
	totals map[int64]int64
	calls  int
}

func newFakePresenceSink() *fakePresenceSink {
	return &fakePresenceSink{totals: make(map[int64]int64)}
}

func (f *fakePresenceSink) AddUserOnlineTime(_ context.Context, userID int64, seconds int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.totals[userID] += seconds
	f.calls++
	return nil
}

func (f *fakePresenceSink) total(userID int64) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.totals[userID]
}

func TestHubOnlineTimeAccumulatesAcrossMultiDeviceAndSettlesOnOffline(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	now := base
	sink := newFakePresenceSink()
	hub := newHub(15 * time.Second)
	hub.sink = sink
	hub.now = func() time.Time { return now }

	first := newClient(store.User{ID: 42})
	second := newClient(store.User{ID: 42})

	hub.register(first)
	now = base.Add(2 * time.Second)
	hub.register(second)

	now = base.Add(5 * time.Second)
	hub.unregister(first, true)

	now = base.Add(8 * time.Second)
	hub.unregister(second, true)

	if got := sink.total(42); got != 8 {
		t.Fatalf("online total = %ds, want 8s (5s+3s, multi-device merged)", got)
	}
}

func TestHubOnlineTimeSettlesOnDisconnectUser(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	now := base
	sink := newFakePresenceSink()
	hub := newHub(15 * time.Second)
	hub.sink = sink
	hub.now = func() time.Time { return now }

	c := newClient(store.User{ID: 42})
	hub.register(c)
	now = base.Add(10 * time.Second)
	hub.DisconnectUser(42)

	if got := sink.total(42); got != 10 {
		t.Fatalf("online total = %ds, want 10s after DisconnectUser", got)
	}
}

func TestHubOnlineTimeFlushPersistsInFlightWithoutEndingSegment(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	now := base
	sink := newFakePresenceSink()
	hub := newHub(15 * time.Second)
	hub.sink = sink
	hub.now = func() time.Time { return now }

	c := newClient(store.User{ID: 42})
	hub.register(c)
	now = base.Add(7 * time.Second)
	hub.flushOnlineTime()

	if got := sink.total(42); got != 7 {
		t.Fatalf("after first flush, online total = %ds, want 7s", got)
	}
	if _, stillOnline := hub.online[42]; !stillOnline {
		t.Fatal("segment ended after flush; flush must keep the user online")
	}

	now = base.Add(13 * time.Second)
	hub.flushOnlineTime()
	if got := sink.total(42); got != 13 {
		t.Fatalf("after second flush, online total = %ds, want 13s (sub-second residual carried)", got)
	}

	now = base.Add(21 * time.Second)
	hub.unregister(c, true)
	if got := sink.total(42); got != 21 {
		t.Fatalf("after settle, online total = %ds, want 21s", got)
	}
}

func TestHubOnlineTimeNilSinkIsNoOp(t *testing.T) {
	hub := newHub(15 * time.Second)
	c := newClient(store.User{ID: 42})
	hub.register(c)
	hub.unregister(c, true)
	if len(hub.online) != 0 {
		t.Fatalf("online map not empty after offline, len = %d", len(hub.online))
	}
}

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
	observer.guilds[10] = struct{}{}
	hub.register(observer)
	for range cap(observer.send) {
		observer.send <- []byte(`{"type":"message_created"}`)
	}

	second := newClient(store.User{ID: 2})
	second.guilds[10] = struct{}{}
	third := newClient(store.User{ID: 3})
	third.guilds[10] = struct{}{}
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

func TestHubDisconnectUserStopsAndUnsubscribesEveryClient(t *testing.T) {
	hub := newHub(15 * time.Second)
	first := newClient(store.User{ID: 5})
	first.guilds[10] = struct{}{}
	second := newClient(store.User{ID: 5})
	second.guilds[20] = struct{}{}
	other := newClient(store.User{ID: 6})
	other.guilds[10] = struct{}{}
	hub.register(first)
	hub.register(second)
	hub.register(other)

	hub.DisconnectUser(5)

	for _, client := range []*client{first, second} {
		select {
		case <-client.done:
		case <-time.After(time.Second):
			t.Fatal("revoked client was not stopped")
		}
		if !client.revoked.Load() {
			t.Fatal("stopped client was not marked revoked")
		}
	}
	assertOnlineUserIDs(t, hub, []int64{6})
	if got := hub.OnlineGuildClients(20); len(got) != 0 {
		t.Fatalf("revoked guild subscriptions = %v", got)
	}

	// The connection handlers may still race to unregister after the Hub has
	// already removed them. This must not change another user's presence.
	hub.unregister(first, true)
	hub.unregister(second, true)
	assertOnlineUserIDs(t, hub, []int64{6})
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

func TestHubGuildBroadcastExcludesClientsWithoutGuildMembership(t *testing.T) {
	hub := newHub(15 * time.Second)
	member := newClient(store.User{ID: 1})
	member.guilds[10] = struct{}{}
	noGuildMembership := newClient(store.User{ID: 2})
	hub.register(member)
	hub.register(noGuildMembership)

	hub.BroadcastGuild(10, "message_created", map[string]int64{"id": 1})
	select {
	case <-member.send:
	case <-time.After(time.Second):
		t.Fatal("guild member did not receive event")
	}
	select {
	case <-noGuildMembership.send:
		t.Fatal("client without a guild membership received event")
	default:
	}
	assertPresenceSnapshot(t, noGuildMembership, nil)
}

func TestHubUserBroadcastRequiresSharedGuild(t *testing.T) {
	hub := newHub(15 * time.Second)
	target := newClient(store.User{ID: 1})
	target.guilds[10] = struct{}{}
	shared := newClient(store.User{ID: 2})
	shared.guilds[10] = struct{}{}
	other := newClient(store.User{ID: 3})
	other.guilds[20] = struct{}{}
	hub.register(target)
	hub.register(shared)
	hub.register(other)

	hub.BroadcastUser(1, "user_updated", map[string]int64{"id": 1})
	for _, client := range []*client{target, shared} {
		select {
		case <-client.send:
		case <-time.After(time.Second):
			t.Fatal("shared guild client did not receive account event")
		}
	}
	select {
	case <-other.send:
		t.Fatal("unrelated guild client received account event")
	default:
	}
}

func TestHubSendUserOnlyTargetsAccountConnections(t *testing.T) {
	hub := newHub(15 * time.Second)
	first := newClient(store.User{ID: 1})
	first.guilds[10] = struct{}{}
	second := newClient(store.User{ID: 1})
	second.guilds[20] = struct{}{}
	sharedGuild := newClient(store.User{ID: 2})
	sharedGuild.guilds[10] = struct{}{}
	hub.register(first)
	hub.register(second)
	hub.register(sharedGuild)

	hub.SendUser(1, "voice_disconnected_by_moderator", map[string]int64{"channelId": 7})
	for _, connection := range []*client{first, second} {
		select {
		case <-connection.send:
		case <-time.After(time.Second):
			t.Fatal("target account connection did not receive event")
		}
	}
	select {
	case <-sharedGuild.send:
		t.Fatal("another account in the same guild received private event")
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
	if got := hub.OnlineGuildClients(10); !slices.Equal(got, []OnlineClient{{UserID: 1, Client: ClientWeb}, {UserID: 2, Client: ClientWeb}}) {
		t.Fatalf("guild 10 online clients = %v", got)
	}
	if got := hub.OnlineGuildClients(20); !slices.Equal(got, []OnlineClient{{UserID: 2, Client: ClientWeb}, {UserID: 3, Client: ClientWeb}}) {
		t.Fatalf("guild 20 online clients = %v", got)
	}
}

func TestHubPeriodicallyRebroadcastsPresence(t *testing.T) {
	hub := newHub(15 * time.Second)
	client := newClient(store.User{ID: 4})
	client.guilds[10] = struct{}{}
	hub.register(client)
	assertPresenceSnapshot(t, client, []int64{4})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.RunPresenceBroadcaster(ctx, time.Millisecond)
	assertPresenceSnapshot(t, client, []int64{4})
}

func TestHubClientTypePriorityPicksHighestAndFallsBack(t *testing.T) {
	hub := newHub(15 * time.Second)
	web := newClient(store.User{ID: 3})
	web.guilds[10] = struct{}{}
	android := newClient(store.User{ID: 3})
	android.guilds[10] = struct{}{}
	android.clientType = ClientAndroid
	electron := newClient(store.User{ID: 3})
	electron.guilds[10] = struct{}{}
	electron.clientType = ClientElectron

	hub.register(web)
	assertOnlineClients(t, hub, []OnlineClient{{UserID: 3, Client: ClientWeb}})
	hub.register(android)
	assertOnlineClients(t, hub, []OnlineClient{{UserID: 3, Client: ClientAndroid}})
	hub.register(electron)
	assertOnlineClients(t, hub, []OnlineClient{{UserID: 3, Client: ClientElectron}})

	// Dropping a connection falls back to the next-highest surviving client.
	hub.unregister(electron, true)
	assertOnlineClients(t, hub, []OnlineClient{{UserID: 3, Client: ClientAndroid}})
	hub.unregister(android, true)
	assertOnlineClients(t, hub, []OnlineClient{{UserID: 3, Client: ClientWeb}})
	hub.unregister(web, true)
	assertOnlineClients(t, hub, nil)
}

func TestHubPresenceBroadcastCarriesClientKind(t *testing.T) {
	hub := newHub(15 * time.Second)
	observer := newClient(store.User{ID: 1})
	observer.guilds[10] = struct{}{}
	hub.register(observer)

	electron := newClient(store.User{ID: 2})
	electron.guilds[10] = struct{}{}
	electron.clientType = ClientElectron
	hub.register(electron)

	assertPresenceClients(t, observer, []OnlineClient{
		{UserID: 1, Client: ClientWeb},
		{UserID: 2, Client: ClientElectron},
	})
}

func assertOnlineUserIDs(t *testing.T, hub *Hub, want []int64) {
	t.Helper()
	clients := hub.OnlineClients()
	ids := make([]int64, 0, len(clients))
	for _, c := range clients {
		ids = append(ids, c.UserID)
	}
	if !slices.Equal(ids, want) {
		t.Fatalf("online user IDs = %v, want %v", ids, want)
	}
}

func assertOnlineClients(t *testing.T, hub *Hub, want []OnlineClient) {
	t.Helper()
	if got := hub.OnlineClients(); !slices.Equal(got, want) {
		t.Fatalf("online clients = %v, want %v", got, want)
	}
}

func assertPresenceClients(t *testing.T, client *client, want []OnlineClient) {
	t.Helper()
	if clients := decodePresenceClients(t, client); !slices.Equal(clients, want) {
		t.Fatalf("presence clients = %v, want %v", clients, want)
	}
}

func assertPresenceSnapshot(t *testing.T, client *client, want []int64) {
	t.Helper()
	clients := decodePresenceClients(t, client)
	ids := make([]int64, 0, len(clients))
	for _, c := range clients {
		ids = append(ids, c.UserID)
	}
	if !slices.Equal(ids, want) {
		t.Fatalf("presence IDs = %v, want %v", ids, want)
	}
}

func decodePresenceClients(t *testing.T, client *client) []OnlineClient {
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
		var clients []OnlineClient
		if err := json.Unmarshal(data, &clients); err != nil {
			t.Fatalf("decode presence clients: %v", err)
		}
		return clients
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for presence snapshot")
		return nil
	}
}
