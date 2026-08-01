package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/yeck/celery-web-speak/internal/store"
)

func TestUpdateMyStatusPersistsAndValidates(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	token := mustSessionToken(t, db, admin.ID)

	recorder := serveGuildHTTPRequest(server, token, http.MethodPatch, "/api/me/status", `{"fixedAway":true}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("set fixed away = %d %s", recorder.Code, recorder.Body.String())
	}
	var resp struct{ User store.User }
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.User.FixedAway {
		t.Fatal("response user must carry fixedAway")
	}

	user, err := db.UserByID(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !user.FixedAway {
		t.Fatal("fixed away must be persisted")
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodPatch, "/api/me/status", `{"fixedAway":false}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("back to auto = %d %s", recorder.Code, recorder.Body.String())
	}
	user, err = db.UserByID(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if user.FixedAway {
		t.Fatal("switching back to auto must persist")
	}
}

func TestUpdateMyStatusRejectsUnauthenticatedAndInvalid(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	token := mustSessionToken(t, db, admin.ID)

	recorder := serveGuildHTTPRequest(server, "", http.MethodPatch, "/api/me/status", `{"fixedAway":true}`)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d, want 401", recorder.Code)
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodPatch, "/api/me/status", `{"fixedAway":true,"extra":1}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unknown field = %d, want 400", recorder.Code)
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodPatch, "/api/me/status", `not json`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid json = %d, want 400", recorder.Code)
	}

	recorder = serveGuildHTTPRequest(server, token, http.MethodPatch, "/api/me/status", `{"fixedAway":"yes"}`)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_json") {
		t.Fatalf("wrong type = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestMeReturnsStatusSetting(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	token := mustSessionToken(t, db, admin.ID)
	if err := db.SetUserFixedAway(ctx, admin.ID, true); err != nil {
		t.Fatal(err)
	}

	recorder := serveGuildHTTPRequest(server, token, http.MethodGet, "/api/me", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("me read = %d %s", recorder.Code, recorder.Body.String())
	}
	var resp struct{ User store.User }
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.User.FixedAway {
		t.Fatal("me must carry the status setting")
	}
}
