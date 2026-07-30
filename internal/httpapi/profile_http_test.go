package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

func TestGetUserProfileRequiresSharedGuild(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	defaultGuild, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// admin is a member of the default guild (bootstrapped).
	// outsider is in no shared guild with admin.
	outsider, err := db.CreateUser(ctx, "profile_outsider", "陌生人", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	outsiderToken, _, err := db.CreateSession(ctx, outsider.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	// outsider asking for admin's profile → 403.
	recorder := serveGuildHTTPRequest(server, outsiderToken, http.MethodGet, "/api/users/"+formatID(admin.ID)+"/profile", "")
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "not_in_shared_guild") {
		t.Fatalf("non-shared-guild profile read = %d %s", recorder.Code, recorder.Body.String())
	}

	// outsider can read their own profile (self bypasses shared-guild check).
	recorder = serveGuildHTTPRequest(server, outsiderToken, http.MethodGet, "/api/users/"+formatID(outsider.ID)+"/profile", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("self profile read = %d %s", recorder.Code, recorder.Body.String())
	}

	// Add outsider to the default guild; now admin and outsider share a guild.
	if _, err := db.AddGuildMember(ctx, defaultGuild, admin.ID, outsider.Username); err != nil {
		t.Fatal(err)
	}
	recorder = serveGuildHTTPRequest(server, outsiderToken, http.MethodGet, "/api/users/"+formatID(admin.ID)+"/profile", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("shared-guild profile read = %d %s", recorder.Code, recorder.Body.String())
	}
	var resp struct{ Profile store.UserProfile }
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Profile.ID != admin.ID {
		t.Fatalf("profile id = %d, want %d", resp.Profile.ID, admin.ID)
	}
}

func TestGetUserProfileReturnsBioAndOnlineTime(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	if _, err := db.UpdateProfile(ctx, admin.ID, "管理员", "我是一段简介", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := db.AddUserOnlineTime(ctx, admin.ID, 3661); err != nil {
		t.Fatal(err)
	}
	token, _, err := db.CreateSession(ctx, admin.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	recorder := serveGuildHTTPRequest(server, token, http.MethodGet, "/api/users/"+formatID(admin.ID)+"/profile", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("profile read = %d %s", recorder.Code, recorder.Body.String())
	}
	var resp struct{ Profile store.UserProfile }
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Profile.Bio != "我是一段简介" {
		t.Fatalf("bio = %q, want 头部简介", resp.Profile.Bio)
	}
	if resp.Profile.OnlineSecondsTotal != 3661 {
		t.Fatalf("onlineSecondsTotal = %d, want 3661", resp.Profile.OnlineSecondsTotal)
	}
	if resp.Profile.CreatedAt.IsZero() {
		t.Fatal("createdAt is zero")
	}
}

func TestGetUserProfileNotFound(t *testing.T) {
	_, _, server := newGuildHTTPTestServer(t)
	recorder := serveGuildHTTPRequest(server, "", http.MethodGet, "/api/users/999999/profile", "")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("no auth profile read = %d, want 401", recorder.Code)
	}
}