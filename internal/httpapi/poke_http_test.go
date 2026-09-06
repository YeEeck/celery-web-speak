package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

func pokeBody(targetUserID int64) string {
	return fmt.Sprintf(`{"targetUserId":%d}`, targetUserID)
}

type pokeEvent struct {
	Type    string `json:"type"`
	GuildID int64  `json:"guildId"`
	Data    struct {
		ActorUserID int64  `json:"actorUserId"`
		DisplayName string `json:"displayName"`
	} `json:"data"`
}

func readPokeEvent(t *testing.T, c *client) pokeEvent {
	t.Helper()
	select {
	case payload := <-c.send:
		var item pokeEvent
		if err := json.Unmarshal(payload, &item); err != nil {
			t.Fatalf("decode poke event: %v", err)
		}
		if item.Type != "poke" {
			t.Fatalf("event type = %q, want poke", item.Type)
		}
		return item
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for poke")
		return pokeEvent{}
	}
}

func assertNoPokeEvent(t *testing.T, c *client) {
	t.Helper()
	select {
	case payload := <-c.send:
		t.Fatalf("unexpected poke event: %s", payload)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestPokeDeliversAccountDirectedEventToOnlineTarget(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "poke_online_target", "被戳用户")
	bystander := newCallPeer(t, db, "poke_online_bystander", "旁观者")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	addToDefaultGuild(t, db, admin.ID, bystander.Username)

	initiatorClient := registerCallClient(t, server, admin.ID)
	targetClient := registerCallClient(t, server, target.ID)
	bystanderClient := registerCallClient(t, server, bystander.ID)

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("poke = %d %s", recorder.Code, recorder.Body.String())
	}

	got := readPokeEvent(t, targetClient)
	if got.GuildID != 0 {
		t.Fatalf("poke guildId = %d, want omitted/0", got.GuildID)
	}
	if got.Data.ActorUserID != admin.ID {
		t.Fatalf("actorUserId = %d, want %d", got.Data.ActorUserID, admin.ID)
	}
	if got.Data.DisplayName != admin.DisplayName {
		t.Fatalf("displayName = %q, want %q", got.Data.DisplayName, admin.DisplayName)
	}
	assertNoPokeEvent(t, bystanderClient)
	assertNoPokeEvent(t, initiatorClient)
}

func TestPokeDeliversToEveryConnectionOfTarget(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "poke_multi_target", "多端目标")
	addToDefaultGuild(t, db, admin.ID, target.Username)

	first := registerCallClient(t, server, target.ID)
	second := registerCallClient(t, server, target.ID)

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("poke = %d %s", recorder.Code, recorder.Body.String())
	}
	gotFirst := readPokeEvent(t, first)
	gotSecond := readPokeEvent(t, second)
	if gotFirst.Data.ActorUserID != admin.ID || gotSecond.Data.ActorUserID != admin.ID {
		t.Fatalf("actor ids = %d/%d, want %d", gotFirst.Data.ActorUserID, gotSecond.Data.ActorUserID, admin.ID)
	}
}

func TestPokeOfflineDoesNotConsumeCooldown(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "poke_offline_target", "离线目标")
	addToDefaultGuild(t, db, admin.ID, target.Username)

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("offline poke = %d %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error != "poke_offline" || payload.Message != "对方不在线" {
		t.Fatalf("offline error = %+v", payload)
	}

	targetClient := registerCallClient(t, server, target.ID)
	recorder = serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("retry after online = %d %s", recorder.Code, recorder.Body.String())
	}
	got := readPokeEvent(t, targetClient)
	if got.Data.ActorUserID != admin.ID {
		t.Fatalf("retry actorUserId = %d, want %d", got.Data.ActorUserID, admin.ID)
	}
}

func TestPokePairCooldownRejectsSecondSuccessWithinWindow(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "poke_pair_target", "冷却目标")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	targetClient := registerCallClient(t, server, target.ID)

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("first poke = %d %s", recorder.Code, recorder.Body.String())
	}
	readPokeEvent(t, targetClient)

	recorder = serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("second poke = %d %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error != "poke_rate_limited" || payload.Message != "戳得太频繁" {
		t.Fatalf("cooldown error = %+v", payload)
	}
	assertNoPokeEvent(t, targetClient)
}

func TestPokeInitiatorCapRejectsNinthSuccessInWindow(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	token := callSessionToken(t, db, admin.ID)
	clients := make([]*client, 8)
	for i := 0; i < 8; i++ {
		target := newCallPeer(t, db, fmt.Sprintf("poke_cap_t%d", i), fmt.Sprintf("目标%d", i+1))
		addToDefaultGuild(t, db, admin.ID, target.Username)
		clients[i] = registerCallClient(t, server, target.ID)
		recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("poke %d = %d %s", i+1, recorder.Code, recorder.Body.String())
		}
		readPokeEvent(t, clients[i])
	}

	ninth := newCallPeer(t, db, "poke_cap_t8", "第九个目标")
	addToDefaultGuild(t, db, admin.ID, ninth.Username)
	ninthClient := registerCallClient(t, server, ninth.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(ninth.ID))
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("ninth poke = %d %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error != "poke_rate_limited" || payload.Message != "戳得太频繁" {
		t.Fatalf("cap error = %+v", payload)
	}
	assertNoPokeEvent(t, ninthClient)
}

func assertPokeUnavailable(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("unavailable poke = %d %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error != "poke_unavailable" || payload.Message != "现在不能戳" {
		t.Fatalf("unavailable error = %+v", payload)
	}
}

func TestPokeSelfIsUnavailable(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	registerCallClient(t, server, admin.ID)
	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(admin.ID))
	assertPokeUnavailable(t, recorder)
}

func TestPokeWithoutSharedGuildIsUnavailable(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	outsider := newCallPeer(t, db, "poke_outsider", "局外人")
	outsiderClient := registerCallClient(t, server, outsider.ID)
	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(outsider.ID))
	assertPokeUnavailable(t, recorder)
	assertNoPokeEvent(t, outsiderClient)
}

func TestPokePlatformAdminWithoutSharedGuildIsUnavailable(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	if !admin.IsPlatformAdmin {
		t.Fatal("bootstrap admin is not a platform admin")
	}
	owner := newCallPeer(t, db, "poke_unjoined_owner", "未共享服所有者")
	if _, err := db.CreateGuild(context.Background(), admin.ID, "未加入的服务器", owner.Username); err != nil {
		t.Fatal(err)
	}
	ownerClient := registerCallClient(t, server, owner.ID)
	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(owner.ID))
	assertPokeUnavailable(t, recorder)
	assertNoPokeEvent(t, ownerClient)
}

func TestPokeBannedInOnlySharedGuildIsUnavailable(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "poke_banned_target", "被封禁目标")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	guildID, err := db.DefaultGuildID(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetGuildMemberBan(context.Background(), guildID, admin.ID, target.ID, true, nil); err != nil {
		t.Fatal(err)
	}
	targetClient := registerCallClient(t, server, target.ID)
	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	assertPokeUnavailable(t, recorder)
	assertNoPokeEvent(t, targetClient)
}

func TestPokeSucceedsDespiteCallBlockAndCallReceivingOff(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "poke_block_target", "屏蔽目标")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	targetClient := registerCallClient(t, server, target.ID)

	adminToken := callSessionToken(t, db, admin.ID)
	targetToken := callSessionToken(t, db, target.ID)

	recorder := serveGuildHTTPRequest(server, targetToken, http.MethodPut, "/api/call-blocks/"+formatID(admin.ID), `{"kind":"permanent"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("set call block = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, targetToken, http.MethodPatch, "/api/me/call-receiving", `{"callReceiving":false}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("disable call receiving = %d %s", recorder.Code, recorder.Body.String())
	}
	select {
	case <-targetClient.send:
	case <-time.After(time.Second):
		t.Fatal("timed out draining user_updated after call-receiving change")
	}

	recorder = serveGuildHTTPRequest(server, adminToken, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("poke through call block = %d %s", recorder.Code, recorder.Body.String())
	}
	got := readPokeEvent(t, targetClient)
	if got.Data.ActorUserID != admin.ID {
		t.Fatalf("actorUserId = %d, want %d", got.Data.ActorUserID, admin.ID)
	}
}

func TestPokeAwayTargetSucceeds(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "poke_away_target", "离开目标")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	targetClient := newClient(store.User{ID: target.ID})
	targetClient.deviceStatus = PresenceAway
	server.hub.register(targetClient)

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("away poke = %d %s", recorder.Code, recorder.Body.String())
	}
	got := readPokeEvent(t, targetClient)
	if got.Data.ActorUserID != admin.ID {
		t.Fatalf("actorUserId = %d, want %d", got.Data.ActorUserID, admin.ID)
	}
}

func TestPokePairWindowExpiresAfterTenSeconds(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	now := time.Unix(1_700_000_000, 0)
	server.pokeLimiter.now = func() time.Time { return now }

	target := newCallPeer(t, db, "poke_expire_target", "窗口过期目标")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	targetClient := registerCallClient(t, server, target.ID)
	token := callSessionToken(t, db, admin.ID)

	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("first poke = %d %s", recorder.Code, recorder.Body.String())
	}
	readPokeEvent(t, targetClient)

	now = now.Add(10 * time.Second)
	recorder = serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("poke after window = %d %s", recorder.Code, recorder.Body.String())
	}
	readPokeEvent(t, targetClient)
}
