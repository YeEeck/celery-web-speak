package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/yeck/celery-web-speak/internal/media"
	"github.com/yeck/celery-web-speak/internal/store"
)

func newCallPeer(t *testing.T, db *store.Store, username, display string) store.User {
	t.Helper()
	user, err := db.CreateUser(context.Background(), username, display, "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func addToDefaultGuild(t *testing.T, db *store.Store, ownerID int64, username string) {
	t.Helper()
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, ownerID, username); err != nil {
		t.Fatal(err)
	}
}

func callSessionToken(t *testing.T, db *store.Store, userID int64) string {
	t.Helper()
	token, _, err := db.CreateSession(context.Background(), userID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func registerCallClient(t *testing.T, server *Server, userID int64) *client {
	t.Helper()
	c := newClient(store.User{ID: userID})
	server.hub.register(c)
	return c
}

func callBody(calleeID int64) string {
	return fmt.Sprintf(`{"calleeUserId":%d}`, calleeID)
}

func assertNoCallEvent(t *testing.T, c *client) {
	t.Helper()
	select {
	case payload := <-c.send:
		t.Fatalf("unexpected call event: %s", payload)
	case <-time.After(100 * time.Millisecond):
	}
}

func readCallEvent(t *testing.T, c *client, wantType string) callEvent {
	t.Helper()
	select {
	case payload := <-c.send:
		var item callEvent
		if err := json.Unmarshal(payload, &item); err != nil {
			t.Fatalf("decode call event: %v", err)
		}
		if item.Type != wantType {
			t.Fatalf("event type = %q, want %q", item.Type, wantType)
		}
		return item
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for %s", wantType)
		return callEvent{}
	}
}

type callEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func callData(t *testing.T, item callEvent) media.CallSignal {
	t.Helper()
	var data media.CallSignal
	if err := json.Unmarshal(item.Data, &data); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestCallCreateSignalsInviteToCallee(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	callee := newCallPeer(t, db, "call_callee", "被叫用户")
	addToDefaultGuild(t, db, admin.ID, callee.Username)

	registerCallClient(t, server, admin.ID)
	calleeClient := registerCallClient(t, server, callee.ID)

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/calls", callBody(callee.ID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("create call = %d %s", recorder.Code, recorder.Body.String())
	}
	var result media.StartCallResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.CallID <= 0 || result.State != media.CallRinging {
		t.Fatalf("create result = %+v", result)
	}
	invite := readCallEvent(t, calleeClient, "call_invite")
	data := callData(t, invite)
	if data.CallID != result.CallID {
		t.Fatalf("invite callId = %d, want %d", data.CallID, result.CallID)
	}
	if data.Peer.UserID != admin.ID || data.Peer.Username != admin.Username {
		t.Fatalf("invite peer = %+v, want caller", data.Peer)
	}
}

func TestCallRejectSignalsCaller(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	callee := newCallPeer(t, db, "call_reject_callee", "被叫")
	addToDefaultGuild(t, db, admin.ID, callee.Username)
	callerClient := registerCallClient(t, server, admin.ID)
	calleeClient := registerCallClient(t, server, callee.ID)

	callerToken := callSessionToken(t, db, admin.ID)
	calleeToken := callSessionToken(t, db, callee.ID)

	recorder := serveGuildHTTPRequest(server, callerToken, http.MethodPost, "/api/calls", callBody(callee.ID))
	var result media.StartCallResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	readCallEvent(t, calleeClient, "call_invite")

	recorder = serveGuildHTTPRequest(server, calleeToken, http.MethodPost, "/api/calls/"+formatID(result.CallID)+"/reject", "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("reject = %d %s", recorder.Code, recorder.Body.String())
	}
	reject := readCallEvent(t, callerClient, "call_reject")
	data := callData(t, reject)
	if data.Reason != media.CallEndRejected {
		t.Fatalf("reject reason = %q, want rejected", data.Reason)
	}
}

func TestCallAcceptHangupAndToken(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	callee := newCallPeer(t, db, "call_accept_callee", "被叫")
	addToDefaultGuild(t, db, admin.ID, callee.Username)
	callerClient := registerCallClient(t, server, admin.ID)
	calleeClient := registerCallClient(t, server, callee.ID)

	callerToken := callSessionToken(t, db, admin.ID)
	calleeToken := callSessionToken(t, db, callee.ID)

	recorder := serveGuildHTTPRequest(server, callerToken, http.MethodPost, "/api/calls", callBody(callee.ID))
	var result media.StartCallResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	readCallEvent(t, calleeClient, "call_invite")

	recorder = serveGuildHTTPRequest(server, calleeToken, http.MethodPost, "/api/calls/"+formatID(result.CallID)+"/accept", "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("accept = %d %s", recorder.Code, recorder.Body.String())
	}
	readCallEvent(t, callerClient, "call_accept")

	recorder = serveGuildHTTPRequest(server, callerToken, http.MethodPost, "/api/calls/"+formatID(result.CallID)+"/token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("caller token = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, calleeToken, http.MethodPost, "/api/calls/"+formatID(result.CallID)+"/token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("callee token = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = serveGuildHTTPRequest(server, callerToken, http.MethodPost, "/api/calls/"+formatID(result.CallID)+"/hangup", "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("hangup = %d %s", recorder.Code, recorder.Body.String())
	}
	end := readCallEvent(t, calleeClient, "call_end")
	data := callData(t, end)
	if data.Reason != media.CallEndNormal {
		t.Fatalf("end reason = %q, want ended", data.Reason)
	}
}

func TestCallBusyWhenCalleeAlreadyRinging(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	callee := newCallPeer(t, db, "call_busy_callee", "被叫")
	third := newCallPeer(t, db, "call_busy_third", "第三者")
	addToDefaultGuild(t, db, admin.ID, callee.Username)
	addToDefaultGuild(t, db, admin.ID, third.Username)
	calleeClient := registerCallClient(t, server, callee.ID)
	thirdClient := registerCallClient(t, server, third.ID)

	callerToken := callSessionToken(t, db, admin.ID)
	thirdToken := callSessionToken(t, db, third.ID)

	recorder := serveGuildHTTPRequest(server, callerToken, http.MethodPost, "/api/calls", callBody(callee.ID))
	var first media.StartCallResult
	if err := json.NewDecoder(recorder.Body).Decode(&first); err != nil {
		t.Fatal(err)
	}
	readCallEvent(t, calleeClient, "call_invite")

	recorder = serveGuildHTTPRequest(server, thirdToken, http.MethodPost, "/api/calls", callBody(callee.ID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("busy create = %d %s", recorder.Code, recorder.Body.String())
	}
	var result media.StartCallResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.State != media.CallEnded || result.Reason != media.CallEndBusy {
		t.Fatalf("busy result = %+v", result)
	}
	busy := readCallEvent(t, thirdClient, "call_busy")
	_ = busy
}

func TestCallCreateRefusedWhenCallerAlreadyInCall(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	callee := newCallPeer(t, db, "call_caller_busy_callee", "被叫")
	other := newCallPeer(t, db, "call_caller_busy_other", "另一位")
	addToDefaultGuild(t, db, admin.ID, callee.Username)
	addToDefaultGuild(t, db, admin.ID, other.Username)
	calleeClient := registerCallClient(t, server, callee.ID)
	registerCallClient(t, server, other.ID)

	token := callSessionToken(t, db, admin.ID)

	// First initiation rings.
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/calls", callBody(callee.ID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("first create = %d %s", recorder.Code, recorder.Body.String())
	}
	readCallEvent(t, calleeClient, "call_invite")

	// Same caller initiates toward a second party while the first call is
	// ringing: refused with 409 (spec 04 忙碌 = 已有任一通话).
	recorder = serveGuildHTTPRequest(server, token, http.MethodPost, "/api/calls", callBody(other.ID))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("caller-busy create = %d %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Error string `json:"error"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error != "call_in_progress" {
		t.Fatalf("caller-busy error code = %q, want call_in_progress", payload.Error)
	}
}

func TestCallUnreachableWhenCalleeOffline(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	callee := newCallPeer(t, db, "call_offline_callee", "被叫")
	addToDefaultGuild(t, db, admin.ID, callee.Username)
	callerClient := registerCallClient(t, server, admin.ID)

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/calls", callBody(callee.ID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("unreachable create = %d %s", recorder.Code, recorder.Body.String())
	}
	var result media.StartCallResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.State != media.CallEnded || result.Reason != media.CallEndUnreachable {
		t.Fatalf("unreachable result = %+v", result)
	}
	readCallEvent(t, callerClient, "call_unreachable")
}

func TestCallRejectsNonSharedGuild(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	outsider := newCallPeer(t, db, "call_outsider", "陌生人")
	callerClient := registerCallClient(t, server, admin.ID)
	registerCallClient(t, server, outsider.ID)

	token := callSessionToken(t, db, admin.ID)
	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/calls", callBody(outsider.ID))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("non-shared create = %d %s, want 403", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Error string `json:"error"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error != "not_in_shared_guild" {
		t.Fatalf("non-shared error code = %q, want not_in_shared_guild", payload.Error)
	}
	// 资格拒绝不进入状态机：不产生任何 call_* 信令。
	assertNoCallEvent(t, callerClient)
}

func TestCallTokenRequiresActive(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	callee := newCallPeer(t, db, "call_token_active_callee", "被叫")
	addToDefaultGuild(t, db, admin.ID, callee.Username)
	calleeClient := registerCallClient(t, server, callee.ID)

	callerToken := callSessionToken(t, db, admin.ID)
	calleeToken := callSessionToken(t, db, callee.ID)

	recorder := serveGuildHTTPRequest(server, callerToken, http.MethodPost, "/api/calls", callBody(callee.ID))
	var result media.StartCallResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	readCallEvent(t, calleeClient, "call_invite")

	// Before accept: a party may not fetch a token (still ringing).
	recorder = serveGuildHTTPRequest(server, calleeToken, http.MethodPost, "/api/calls/"+formatID(result.CallID)+"/token", "")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("pre-accept token = %d, want 409", recorder.Code)
	}

	// After accept: both parties fetch tokens successfully.
	recorder = serveGuildHTTPRequest(server, calleeToken, http.MethodPost, "/api/calls/"+formatID(result.CallID)+"/accept", "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("accept = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, calleeToken, http.MethodPost, "/api/calls/"+formatID(result.CallID)+"/token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("post-accept callee token = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = serveGuildHTTPRequest(server, callerToken, http.MethodPost, "/api/calls/"+formatID(result.CallID)+"/token", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("post-accept caller token = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestCallTokenRestrictedToParties(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	callee := newCallPeer(t, db, "call_token_callee", "被叫")
	outsider := newCallPeer(t, db, "call_token_outsider", "路人")
	addToDefaultGuild(t, db, admin.ID, callee.Username)
	addToDefaultGuild(t, db, admin.ID, outsider.Username)
	calleeClient := registerCallClient(t, server, callee.ID)

	callerToken := callSessionToken(t, db, admin.ID)
	outsiderToken := callSessionToken(t, db, outsider.ID)

	recorder := serveGuildHTTPRequest(server, callerToken, http.MethodPost, "/api/calls", callBody(callee.ID))
	var result media.StartCallResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	readCallEvent(t, calleeClient, "call_invite")

	recorder = serveGuildHTTPRequest(server, outsiderToken, http.MethodPost, "/api/calls/"+formatID(result.CallID)+"/token", "")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("outsider token = %d, want 403", recorder.Code)
	}
}
