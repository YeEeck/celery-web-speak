package httpapi

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yeck/celery-web-speak/internal/store"
)

func TestPatchMyCallReceivingBroadcastsUserUpdated(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	first := registerCallClient(t, server, admin.ID)
	second := registerCallClient(t, server, admin.ID)
	token := callSessionToken(t, db, admin.ID)

	recorder := serveGuildHTTPRequest(server, token, http.MethodPatch, "/api/me/call-receiving", `{"callReceiving":false}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("patch call receiving = %d %s", recorder.Code, recorder.Body.String())
	}
	for _, connection := range []*client{first, second} {
		events := readClientEvents(t, connection, 1)
		if events[0].Type != "user_updated" {
			t.Fatalf("event type = %q, want user_updated", events[0].Type)
		}
		var data struct {
			CallReceiving bool `json:"callReceiving"`
		}
		payload, err := json.Marshal(events[0].Data)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(payload, &data); err != nil {
			t.Fatal(err)
		}
		if data.CallReceiving {
			t.Fatalf("broadcast callReceiving = true, want false")
		}
	}
}

func TestPatchMyCallReceiving(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	token := callSessionToken(t, db, admin.ID)

	// 规格要求显式布尔：空 body 或 null 不能静默当作 false 关闭被呼叫。
	recorder := serveGuildHTTPRequest(server, token, http.MethodPatch, "/api/me/call-receiving", `{}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("empty body = %d %s, want 400", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, token, http.MethodPatch, "/api/me/call-receiving", `{"callReceiving":null}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("null callReceiving = %d %s, want 400", recorder.Code, recorder.Body.String())
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodPatch, "/api/me/call-receiving", `{"callReceiving":false}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("patch call receiving = %d %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		User struct {
			CallReceiving bool `json:"callReceiving"`
		} `json:"user"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.User.CallReceiving {
		t.Fatal("user.callReceiving = true after disable, want false")
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodPatch, "/api/me/call-receiving", `{"callReceiving":true}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("re-enable call receiving = %d %s", recorder.Code, recorder.Body.String())
	}
}

type blockPayload struct {
	Block struct {
		Kind      string `json:"kind"`
		ExpiresAt string `json:"expiresAt"`
	} `json:"block"`
}

func TestCallBlockEndpointsLifecycle(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "block_endpoint_target", "屏蔽对象")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	outsider := newCallPeer(t, db, "block_endpoint_outsider", "局外人")
	token := callSessionToken(t, db, admin.ID)

	// First-time block requires a shared guild.
	recorder := serveGuildHTTPRequest(server, token, http.MethodPut, "/api/call-blocks/"+formatID(outsider.ID), `{"kind":"temporary"}`)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "not_in_shared_guild") {
		t.Fatalf("outsider block = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodPut, "/api/call-blocks/"+formatID(target.ID), `{"kind":"temporary"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("set temporary block = %d %s", recorder.Code, recorder.Body.String())
	}
	var temporary blockPayload
	if err := json.NewDecoder(recorder.Body).Decode(&temporary); err != nil {
		t.Fatal(err)
	}
	if temporary.Block.Kind != "temporary" || temporary.Block.ExpiresAt == "" {
		t.Fatalf("temporary block payload = %+v", temporary)
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodGet, "/api/call-blocks/"+formatID(target.ID), "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("read block = %d %s", recorder.Code, recorder.Body.String())
	}
	if err := json.NewDecoder(recorder.Body).Decode(&temporary); err != nil {
		t.Fatal(err)
	}
	if temporary.Block.Kind != "temporary" || temporary.Block.ExpiresAt == "" {
		t.Fatalf("read block payload = %+v", temporary)
	}

	// Convert temporary → permanent.
	recorder = serveGuildHTTPRequest(server, token, http.MethodPut, "/api/call-blocks/"+formatID(target.ID), `{"kind":"permanent"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("convert to permanent = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodGet, "/api/call-blocks", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("list blocks = %d %s", recorder.Code, recorder.Body.String())
	}
	var listPayload struct {
		Blocks []struct {
			UserID    int64  `json:"userId"`
			Username  string `json:"username"`
			Kind      string `json:"kind"`
			ExpiresAt string `json:"expiresAt"`
		} `json:"blocks"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&listPayload); err != nil {
		t.Fatal(err)
	}
	if len(listPayload.Blocks) != 1 || listPayload.Blocks[0].UserID != target.ID ||
		listPayload.Blocks[0].Username != target.Username || listPayload.Blocks[0].Kind != "permanent" {
		t.Fatalf("block list = %+v", listPayload)
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodDelete, "/api/call-blocks/"+formatID(target.ID), "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("delete block = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, token, http.MethodGet, "/api/call-blocks/"+formatID(target.ID), "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("read after delete = %d %s", recorder.Code, recorder.Body.String())
	}
	var absent struct {
		Block any `json:"block"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&absent); err != nil {
		t.Fatal(err)
	}
	if absent.Block != nil {
		t.Fatalf("block after delete = %v, want null", absent.Block)
	}
}

func TestCallBlockEndpointsValidation(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "block_validation_target", "校验对象")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	deleted := newCallPeer(t, db, "block_validation_deleted", "已删除对象")
	addToDefaultGuild(t, db, admin.ID, deleted.Username)
	if err := db.DeleteUser(t.Context(), admin.ID, deleted.ID, deleted.Username); err != nil {
		t.Fatal(err)
	}
	token := callSessionToken(t, db, admin.ID)

	recorder := serveGuildHTTPRequest(server, token, http.MethodPut, "/api/call-blocks/"+formatID(target.ID), `{"kind":"forever"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid kind = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, token, http.MethodPut, "/api/call-blocks/"+formatID(admin.ID), `{"kind":"temporary"}`)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "self_action") {
		t.Fatalf("self block = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, token, http.MethodPut, "/api/call-blocks/999999", `{"kind":"temporary"}`)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing target = %d %s", recorder.Code, recorder.Body.String())
	}

	// 读取同样校验目标：自己 400 self_action，不存在/已删除 404 not_found。
	recorder = serveGuildHTTPRequest(server, token, http.MethodGet, "/api/call-blocks/"+formatID(admin.ID), "")
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "self_action") {
		t.Fatalf("self read = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, token, http.MethodGet, "/api/call-blocks/999999", "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing target read = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, token, http.MethodGet, "/api/call-blocks/"+formatID(deleted.ID), "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("deleted target read = %d %s", recorder.Code, recorder.Body.String())
	}

	// 解除幂等 204：重复删除不存在的屏蔽行成功；自己仍按规格 L160 拒绝 400。
	recorder = serveGuildHTTPRequest(server, token, http.MethodDelete, "/api/call-blocks/999999", "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("idempotent delete = %d %s, want 204", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, token, http.MethodDelete, "/api/call-blocks/"+formatID(admin.ID), "")
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "self_action") {
		t.Fatalf("self delete = %d %s, want 400 self_action", recorder.Code, recorder.Body.String())
	}

	recorder = serveGuildHTTPRequest(server, "", http.MethodGet, "/api/call-blocks", "")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated list = %d, want 401", recorder.Code)
	}
}

func TestCallBlockEndpointsAllowUpdateAfterLosingSharedGuild(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "block_kept_target", "保留对象")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	token := callSessionToken(t, db, admin.ID)

	recorder := serveGuildHTTPRequest(server, token, http.MethodPut, "/api/call-blocks/"+formatID(target.ID), `{"kind":"temporary"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("initial block = %d %s", recorder.Code, recorder.Body.String())
	}

	guildID, err := db.DefaultGuildID(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RemoveGuildMember(t.Context(), guildID, admin.ID, target.ID); err != nil {
		t.Fatal(err)
	}

	// Existing block may still be converted or removed without shared guild.
	recorder = serveGuildHTTPRequest(server, token, http.MethodPut, "/api/call-blocks/"+formatID(target.ID), `{"kind":"permanent"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("convert after leaving shared guild = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, token, http.MethodDelete, "/api/call-blocks/"+formatID(target.ID), "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("delete after leaving shared guild = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestCallCreateUnavailableWhenCalleeDisabledCallReceiving(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	callee := newCallPeer(t, db, "call_disabled_callee", "被叫")
	addToDefaultGuild(t, db, admin.ID, callee.Username)
	callerClient := registerCallClient(t, server, admin.ID)
	calleeClient := registerCallClient(t, server, callee.ID)
	if err := db.SetUserCallReceiving(t.Context(), callee.ID, false); err != nil {
		t.Fatal(err)
	}

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/calls", callBody(callee.ID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("create call = %d %s", recorder.Code, recorder.Body.String())
	}
	var result struct {
		State  string `json:"state"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.State != "ended" || result.Reason != "unavailable" {
		t.Fatalf("disabled callee result = %+v, want ended(unavailable)", result)
	}
	event := readCallEvent(t, callerClient, "call_unavailable")
	if data := callData(t, event); data.Reason != "unavailable" || data.Peer.UserID != callee.ID {
		t.Fatalf("unavailable event = %+v", data)
	}
	assertNoCallEvent(t, calleeClient)
}

func TestCallCreateUnavailableWhenCalleeBlockedCaller(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	callee := newCallPeer(t, db, "call_blocked_callee", "被叫")
	addToDefaultGuild(t, db, admin.ID, callee.Username)
	callerClient := registerCallClient(t, server, admin.ID)
	calleeClient := registerCallClient(t, server, callee.ID)
	if _, err := db.SetCallBlock(t.Context(), callee.ID, admin.ID, store.CallBlockKindTemporary); err != nil {
		t.Fatal(err)
	}

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/calls", callBody(callee.ID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("create call = %d %s", recorder.Code, recorder.Body.String())
	}
	var result struct {
		State  string `json:"state"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.State != "ended" || result.Reason != "unavailable" {
		t.Fatalf("blocked callee result = %+v, want ended(unavailable)", result)
	}
	readCallEvent(t, callerClient, "call_unavailable")
	assertNoCallEvent(t, calleeClient)
}

func TestCallCreateBlockDoesNotPreventOwnerCallingTarget(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "call_block_owner_target", "被屏蔽者")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	calleeClient := registerCallClient(t, server, target.ID)
	if _, err := db.SetCallBlock(t.Context(), admin.ID, target.ID, store.CallBlockKindPermanent); err != nil {
		t.Fatal(err)
	}

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/calls", callBody(target.ID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("owner calls blocked target = %d %s", recorder.Code, recorder.Body.String())
	}
	var result struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.State != "ringing" {
		t.Fatalf("owner call result state = %q, want ringing", result.State)
	}
	readCallEvent(t, calleeClient, "call_invite")
}

func TestCallCreateBlockedOfflineStillUnavailable(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	callee := newCallPeer(t, db, "call_blocked_offline_callee", "被叫")
	addToDefaultGuild(t, db, admin.ID, callee.Username)
	callerClient := registerCallClient(t, server, admin.ID)
	if _, err := db.SetCallBlock(t.Context(), callee.ID, admin.ID, store.CallBlockKindPermanent); err != nil {
		t.Fatal(err)
	}

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/calls", callBody(callee.ID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("create call = %d %s", recorder.Code, recorder.Body.String())
	}
	var result struct {
		State  string `json:"state"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.State != "ended" || result.Reason != "unavailable" {
		t.Fatalf("blocked offline result = %+v, want ended(unavailable)", result)
	}
	readCallEvent(t, callerClient, "call_unavailable")
}

func TestCallCreateAllowedAfterTemporaryBlockExpired(t *testing.T) {
	path := filepath.Join(t.TempDir(), "expired-block.db")
	db, admin, server := newGuildHTTPTestServerWithPath(t, path)
	callee := newCallPeer(t, db, "call_expired_block_callee", "被叫")
	addToDefaultGuild(t, db, admin.ID, callee.Username)
	calleeClient := registerCallClient(t, server, callee.ID)
	if _, err := db.SetCallBlock(t.Context(), callee.ID, admin.ID, store.CallBlockKindTemporary); err != nil {
		t.Fatal(err)
	}

	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec("UPDATE call_blocks SET expires_at = '2000-01-01T00:00:00Z' WHERE owner_user_id = ? AND target_user_id = ?", callee.ID, admin.ID); err != nil {
		raw.Close()
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/calls", callBody(callee.ID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("create call = %d %s", recorder.Code, recorder.Body.String())
	}
	var result struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.State != "ringing" {
		t.Fatalf("expired block call state = %q, want ringing", result.State)
	}
	readCallEvent(t, calleeClient, "call_invite")
}

func TestCallBlockCandidates(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	shared := newCallPeer(t, db, "block_search_shared", "搜索对象")
	blocked := newCallPeer(t, db, "block_search_blocked", "已屏蔽对象")
	addToDefaultGuild(t, db, admin.ID, shared.Username)
	addToDefaultGuild(t, db, admin.ID, blocked.Username)
	outsider := newCallPeer(t, db, "block_search_outsider", "局外人")
	token := callSessionToken(t, db, admin.ID)

	recorder := serveGuildHTTPRequest(server, token, http.MethodPut, "/api/call-blocks/"+formatID(blocked.ID), `{"kind":"permanent"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("setup block = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodGet, "/api/call-blocks/candidates?q=", "")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("empty query = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodGet, "/api/call-blocks/candidates?q=block_search", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("candidates = %d %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Users []struct {
			UserID int64 `json:"userId"`
			Block  *struct {
				Kind string `json:"kind"`
			} `json:"block"`
		} `json:"users"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Users) != 2 {
		t.Fatalf("candidate count = %d, want 2", len(payload.Users))
	}
	ids := map[int64]*struct{ Kind string }{
		payload.Users[0].UserID: nil,
		payload.Users[1].UserID: nil,
	}
	if payload.Users[0].Block != nil {
		ids[payload.Users[0].UserID] = &struct{ Kind string }{payload.Users[0].Block.Kind}
	}
	if payload.Users[1].Block != nil {
		ids[payload.Users[1].UserID] = &struct{ Kind string }{payload.Users[1].Block.Kind}
	}
	if _, ok := ids[shared.ID]; !ok {
		t.Fatalf("shared candidate missing: %+v", payload.Users)
	}
	if block := ids[blocked.ID]; block == nil || block.Kind != "permanent" {
		t.Fatalf("blocked candidate state = %+v", ids)
	}
	if _, ok := ids[outsider.ID]; ok {
		t.Fatalf("outsider leaked into candidates: %+v", payload.Users)
	}
}
