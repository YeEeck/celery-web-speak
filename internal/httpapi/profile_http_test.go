package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

func mustSessionToken(t *testing.T, db *store.Store, userID int64) string {
	t.Helper()
	token, _, err := db.CreateSession(context.Background(), userID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestGetUserProfileRequiresSharedGuild(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()

	// outsider shares no guild with admin → 403 not_in_shared_guild.
	outsider, err := db.CreateUser(ctx, "profile_outsider", "陌生人", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	outsiderToken, _, err := db.CreateSession(ctx, outsider.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	recorder := serveGuildHTTPRequest(server, outsiderToken, http.MethodGet, "/api/users/"+formatID(admin.ID)+"/profile", "")
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "not_in_shared_guild") {
		t.Fatalf("non-shared-guild profile read = %d %s", recorder.Code, recorder.Body.String())
	}

	// self bypasses the shared-guild check.
	recorder = serveGuildHTTPRequest(server, outsiderToken, http.MethodGet, "/api/users/"+formatID(outsider.ID)+"/profile", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("self profile read = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestGetUserProfilePlatformAdminBypass(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()

	outsider, err := db.CreateUser(ctx, "profile_bypass_outsider", "路人", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	recorder := serveGuildHTTPRequest(server, mustSessionToken(t, db, admin.ID), http.MethodGet, "/api/users/"+formatID(outsider.ID)+"/profile", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("platform admin bypass read = %d %s", recorder.Code, recorder.Body.String())
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
	recorder := serveGuildHTTPRequest(server, mustSessionToken(t, db, admin.ID), http.MethodGet, "/api/users/"+formatID(admin.ID)+"/profile", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("profile read = %d %s", recorder.Code, recorder.Body.String())
	}
	var resp struct{ Profile store.UserProfile }
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Profile.Bio != "我是一段简介" {
		t.Fatalf("bio = %q, want 我是一段简介", resp.Profile.Bio)
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

func TestGetUserProfileGuildScopedRequiresRequesterMembership(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	defaultGuild, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	outsider, err := db.CreateUser(ctx, "profile_guild_outsider", "陌生人", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	outsiderToken, _, err := db.CreateSession(ctx, outsider.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	scopedPath := "/api/users/" + formatID(admin.ID) + "/profile?guild_id=" + formatID(defaultGuild)
	recorder := serveGuildHTTPRequest(server, outsiderToken, http.MethodGet, scopedPath, "")
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "not_guild_member") {
		t.Fatalf("non-member scoped profile read = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestGetUserProfileGuildScopedRejectsNonMemberTarget(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	defaultGuild, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	target, err := db.CreateUser(ctx, "profile_guild_target", "路人", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	scopedPath := "/api/users/" + formatID(target.ID) + "/profile?guild_id=" + formatID(defaultGuild)
	recorder := serveGuildHTTPRequest(server, mustSessionToken(t, db, admin.ID), http.MethodGet, scopedPath, "")
	if recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), `"error":"not_found"`) {
		t.Fatalf("non-member target scoped read = %d %s", recorder.Code, recorder.Body.String())
	}

	nonexistentPath := "/api/users/999999/profile?guild_id=" + formatID(defaultGuild)
	recorder = serveGuildHTTPRequest(server, mustSessionToken(t, db, admin.ID), http.MethodGet, nonexistentPath, "")
	if recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), `"error":"not_found"`) {
		t.Fatalf("nonexistent target scoped read = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestGetUserProfileGuildScopedRejectsInactiveTarget(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	defaultGuild, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	target, err := db.CreateUser(ctx, "profile_inactive_target", "非活跃目标", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, defaultGuild, admin.ID, target.Username); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetGuildMemberBan(ctx, defaultGuild, admin.ID, target.ID, true, nil); err != nil {
		t.Fatal(err)
	}
	scopedPath := "/api/users/" + formatID(target.ID) + "/profile?guild_id=" + formatID(defaultGuild)
	recorder := serveGuildHTTPRequest(server, mustSessionToken(t, db, admin.ID), http.MethodGet, scopedPath, "")
	if recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), `"error":"not_found"`) {
		t.Fatalf("banned target scoped read = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestGetUserProfileGuildScopedReturnsVoiceSeconds(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	defaultGuild, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AddGuildVoiceTime(ctx, defaultGuild, admin.ID, 7200); err != nil {
		t.Fatal(err)
	}
	token := mustSessionToken(t, db, admin.ID)

	// Unscoped read: voice fields are absent.
	unscoped := serveGuildHTTPRequest(server, token, http.MethodGet, "/api/users/"+formatID(admin.ID)+"/profile", "")
	if unscoped.Code != http.StatusOK {
		t.Fatalf("unscoped self profile read = %d %s", unscoped.Code, unscoped.Body.String())
	}
	for _, field := range []string{"voiceSecondsTotal", "voiceXpTotal", "voiceProgress"} {
		if strings.Contains(unscoped.Body.String(), field) {
			t.Fatalf("unscoped response must not carry %s, got %s", field, unscoped.Body.String())
		}
	}

	// Scoped read: voice fields report the accumulated values.
	scopedPath := "/api/users/" + formatID(admin.ID) + "/profile?guild_id=" + formatID(defaultGuild)
	scoped := serveGuildHTTPRequest(server, token, http.MethodGet, scopedPath, "")
	if scoped.Code != http.StatusOK {
		t.Fatalf("scoped self profile read = %d %s", scoped.Code, scoped.Body.String())
	}
	var resp struct {
		Profile store.UserProfile
	}
	if err := json.Unmarshal(scoped.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Profile.VoiceSecondsTotal == nil || *resp.Profile.VoiceSecondsTotal != 7200 {
		got := "(nil)"
		if resp.Profile.VoiceSecondsTotal != nil {
			got = strconv.FormatInt(*resp.Profile.VoiceSecondsTotal, 10)
		}
		t.Fatalf("voiceSecondsTotal = %s, want 7200", got)
	}
	if resp.Profile.VoiceXPTotal == nil || *resp.Profile.VoiceXPTotal != 120 {
		got := "(nil)"
		if resp.Profile.VoiceXPTotal != nil {
			got = strconv.FormatInt(*resp.Profile.VoiceXPTotal, 10)
		}
		t.Fatalf("voiceXpTotal = %s, want 120", got)
	}
	if resp.Profile.VoiceProgress == nil {
		t.Fatalf("voiceProgress = nil, want {level=2,*}")
	}
	if got, want := resp.Profile.VoiceProgress.Level, int64(2); got != want {
		t.Fatalf("voiceProgress.level = %d, want %d", got, want)
	}
	if got, want := resp.Profile.VoiceProgress.XP, int64(120); got != want {
		t.Fatalf("voiceProgress.xp = %d, want %d", got, want)
	}
	if got, want := resp.Profile.VoiceProgress.LevelStart, int64(120); got != want {
		t.Fatalf("voiceProgress.levelStartXp = %d, want %d", got, want)
	}
	if got, want := resp.Profile.VoiceProgress.LevelEnd, int64(210); got != want {
		t.Fatalf("voiceProgress.levelEndXp = %d, want %d", got, want)
	}
}
