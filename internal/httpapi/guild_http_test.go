package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yeck/celery-web-speak/internal/config"
	"github.com/yeck/celery-web-speak/internal/media"
	"github.com/yeck/celery-web-speak/internal/store"
)

func TestPlatformUsersRequirePlatformAdmin(t *testing.T) {
	db, _, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	member, err := db.CreateUser(ctx, "platform_list_member", "普通账号", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := db.CreateSession(ctx, member.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	recorder := serveGuildHTTPRequest(server, token, http.MethodGet, "/api/platform/users", "")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("platform users status = %d, want 403", recorder.Code)
	}
}

func TestLegacyAPIRoutesAreNotFound(t *testing.T) {
	_, _, server := newGuildHTTPTestServer(t)
	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/messages"},
		{http.MethodPost, "/api/channels"},
		{http.MethodGet, "/api/channels/1/messages"},
		{http.MethodPost, "/api/voice/leave"},
		{http.MethodGet, "/api/admin/invites"},
		{http.MethodPost, "/api/admin/users/1/kick"},
	}
	for _, testCase := range cases {
		recorder := serveGuildHTTPRequest(server, "", testCase.method, testCase.path, "")
		if recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), `"error":"not_found"`) {
			t.Fatalf("%s %s = %d %s", testCase.method, testCase.path, recorder.Code, recorder.Body.String())
		}
	}
}

func TestPlatformUserRoleManagement(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	target, err := db.CreateUser(ctx, "platform_role_target", "角色目标", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	adminToken, _, err := db.CreateSession(ctx, admin.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	recorder := serveGuildHTTPRequest(server, adminToken, http.MethodPatch, "/api/platform/users/"+formatID(admin.ID)+"/role", `{"role":"member"}`)
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "last_platform_admin") {
		t.Fatalf("last platform admin demotion = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = serveGuildHTTPRequest(server, adminToken, http.MethodPatch, "/api/platform/users/"+formatID(target.ID)+"/role", `{"role":"platform_admin"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("promote platform admin = %d %s", recorder.Code, recorder.Body.String())
	}
	updated, err := db.UserByID(ctx, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Role != store.RolePlatformAdmin || !updated.IsPlatformAdmin {
		t.Fatalf("promoted user role/admin = %q/%t", updated.Role, updated.IsPlatformAdmin)
	}

	recorder = serveGuildHTTPRequest(server, adminToken, http.MethodGet, "/api/platform/users", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("list platform users = %d %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Users []store.User `json:"users"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, user := range payload.Users {
		if user.ID == target.ID {
			found = user.IsPlatformAdmin
		}
	}
	if !found {
		t.Fatal("platform user list did not expose promoted administrator state")
	}

	recorder = serveGuildHTTPRequest(server, adminToken, http.MethodPatch, "/api/platform/users/"+formatID(target.ID)+"/role", `{"role":"channel_admin"}`)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_platform_role") {
		t.Fatalf("legacy platform role = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = serveGuildHTTPRequest(server, adminToken, http.MethodPatch, "/api/platform/users/"+formatID(target.ID)+"/role", `{"role":"member"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("demote platform admin = %d %s", recorder.Code, recorder.Body.String())
	}
	updated, err = db.UserByID(ctx, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Role != store.RoleMember || updated.IsPlatformAdmin {
		t.Fatalf("demoted user role/admin = %q/%t", updated.Role, updated.IsPlatformAdmin)
	}
}

func TestPlatformAdminCannotSuspendSelf(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	token, _, err := db.CreateSession(context.Background(), admin.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	recorder := serveGuildHTTPRequest(server, token, http.MethodPatch, "/api/platform/users/"+formatID(admin.ID)+"/suspend", `{"suspended":true}`)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "self_action") {
		t.Fatalf("self suspension = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestServerVoiceLeaveRequiresMembership(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	serverID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	member, err := db.CreateUser(ctx, "voice_leave_member", "离开语音成员", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, serverID, admin.ID, member.Username); err != nil {
		t.Fatal(err)
	}
	token, _, err := db.CreateSession(ctx, member.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/servers/"+formatID(serverID)+"/voice/leave", "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("server voice leave = %d %s", recorder.Code, recorder.Body.String())
	}
	owner, err := db.CreateUser(ctx, "voice_leave_owner", "其他服务器所有者", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	other, err := db.CreateGuild(ctx, admin.ID, "其他服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	adminToken, _, err := db.CreateSession(ctx, admin.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	recorder = serveGuildHTTPRequest(server, adminToken, http.MethodPost, "/api/servers/"+formatID(other.ID)+"/voice/leave", "")
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "server_membership_required") {
		t.Fatalf("unjoined server voice leave = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestPlatformResetPasswordRevokesSessions(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	target, err := db.CreateUser(ctx, "password_reset_target", "密码目标", "old-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	targetToken, _, err := db.CreateSession(ctx, target.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	adminToken, _, err := db.CreateSession(ctx, admin.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	recorder := serveGuildHTTPRequest(server, adminToken, http.MethodPost, "/api/platform/users/"+formatID(target.ID)+"/reset-password", `{"password":"new-secure-password"}`)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("reset password = %d %s", recorder.Code, recorder.Body.String())
	}
	if _, err := db.UserBySession(ctx, targetToken); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("old session error = %v, want ErrNotFound", err)
	}
	if _, err := db.Authenticate(ctx, target.Username, "old-secure-password"); !errors.Is(err, store.ErrInvalidLogin) {
		t.Fatalf("old password error = %v, want ErrInvalidLogin", err)
	}
	if _, err := db.Authenticate(ctx, target.Username, "new-secure-password"); err != nil {
		t.Fatalf("new password authentication: %v", err)
	}
}

func TestServerRenamePermissions(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	owner, err := db.CreateUser(ctx, "rename_owner", "重命名所有者", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	guild, err := db.CreateGuild(ctx, admin.ID, "重命名前", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	adminToken, _, err := db.CreateSession(ctx, admin.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	ownerToken, _, err := db.CreateSession(ctx, owner.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	recorder := serveGuildHTTPRequest(server, adminToken, http.MethodPatch, "/api/platform/servers/"+formatID(guild.ID), `{"name":"平台重命名"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("platform rename = %d %s", recorder.Code, recorder.Body.String())
	}
	updated, err := db.GuildByID(ctx, guild.ID)
	if err != nil || updated.Name != "平台重命名" {
		t.Fatalf("platform renamed guild = %#v, err = %v", updated, err)
	}

	recorder = serveGuildHTTPRequest(server, ownerToken, http.MethodPatch, "/api/platform/servers/"+formatID(guild.ID), `{"name":"越权重命名"}`)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("non-platform rename = %d, want 403", recorder.Code)
	}

	recorder = serveGuildHTTPRequest(server, ownerToken, http.MethodPatch, "/api/servers/"+formatID(guild.ID), `{"name":"所有者重命名"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("owner rename = %d %s", recorder.Code, recorder.Body.String())
	}
	updated, err = db.GuildByID(ctx, guild.ID)
	if err != nil || updated.Name != "所有者重命名" {
		t.Fatalf("owner renamed guild = %#v, err = %v", updated, err)
	}
}

func TestServerMemberLeaveAndRemoval(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	leaving, err := db.CreateUser(ctx, "leaving_member", "主动离开成员", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	removed, err := db.CreateUser(ctx, "removed_member", "被移出成员", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range []store.User{leaving, removed} {
		if _, err := db.AddGuildMember(ctx, guildID, admin.ID, user.Username); err != nil {
			t.Fatal(err)
		}
	}
	leavingToken, _, err := db.CreateSession(ctx, leaving.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	adminToken, _, err := db.CreateSession(ctx, admin.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	recorder := serveGuildHTTPRequest(server, leavingToken, http.MethodPost, "/api/servers/"+formatID(guildID)+"/leave", "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("member leave = %d %s", recorder.Code, recorder.Body.String())
	}
	if _, err := db.GuildMembership(ctx, guildID, leaving.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("leaving membership error = %v, want ErrNotFound", err)
	}

	recorder = serveGuildHTTPRequest(server, adminToken, http.MethodPost, "/api/servers/"+formatID(guildID)+"/leave", "")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("owner leave = %d, want 400", recorder.Code)
	}

	recorder = serveGuildHTTPRequest(server, adminToken, http.MethodPost, "/api/servers/"+formatID(guildID)+"/members/"+formatID(removed.ID)+"/kick", "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("remove member = %d %s", recorder.Code, recorder.Body.String())
	}
	if _, err := db.GuildMembership(ctx, guildID, removed.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("removed membership error = %v, want ErrNotFound", err)
	}
}

func TestGuildAuthorizationDoesNotCrossServerThroughLegacyOrScopedRoutes(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	owner, err := db.CreateUser(ctx, "other_owner", "另一个所有者", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	second, err := db.CreateGuild(ctx, admin.ID, "另一个服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	channels, err := db.ListGuildChannels(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	var textChannel store.Channel
	for _, channel := range channels {
		if channel.Type == store.ChannelTypeText {
			textChannel = channel
			break
		}
	}
	if textChannel.ID == 0 {
		t.Fatal("second server has no text channel")
	}
	member, err := db.CreateUser(ctx, "member_a", "默认服务器成员", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	servers, err := db.ListGuildsForUser(ctx, admin.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	var defaultServerID int64
	for _, item := range servers {
		if item.ID != second.ID && item.Joined {
			defaultServerID = item.ID
			break
		}
	}
	if defaultServerID == 0 {
		t.Fatal("default server not found")
	}
	if _, err := db.AddGuildMember(ctx, defaultServerID, admin.ID, member.Username); err != nil {
		t.Fatal(err)
	}
	memberToken, _, err := db.CreateSession(ctx, member.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{
		"/api/channels/" + formatID(textChannel.ID) + "/messages",
		"/api/servers/" + formatID(second.ID) + "/channels/" + formatID(textChannel.ID) + "/messages",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(&http.Cookie{Name: "test_session", Value: memberToken})
		recorder := httptest.NewRecorder()
		server.Handler().ServeHTTP(recorder, req)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, want 404", path, recorder.Code)
		}
	}

	adminToken, _, err := db.CreateSession(ctx, admin.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/servers/"+formatID(second.ID)+"/bootstrap", nil)
	req.AddCookie(&http.Cookie{Name: "test_session", Value: adminToken})
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "server_membership_required") {
		t.Fatalf("unjoined platform admin response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func newGuildHTTPTestServer(t *testing.T) (*store.Store, store.User, *Server) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	admin := bootstrapHTTPAdmin(t, db)
	cfg := config.Config{
		CookieName:       "test_session",
		SessionTTL:       time.Hour,
		CookieSecure:     false,
		LiveKitURL:       "http://127.0.0.1:1",
		LiveKitPublicURL: "ws://127.0.0.1:7880",
		LiveKitAPIKey:    "key",
		LiveKitAPISecret: "secret",
	}
	server := New(cfg, db, media.New(cfg.LiveKitURL, cfg.LiveKitPublicURL, cfg.LiveKitAPIKey, cfg.LiveKitAPISecret), slog.New(slog.NewTextHandler(io.Discard, nil)))
	return db, admin, server
}

func bootstrapHTTPAdmin(t *testing.T, db *store.Store) store.User {
	t.Helper()
	if err := db.EnsureBootstrapAdmin(context.Background(), "root_admin", "very-secure-password"); err != nil {
		t.Fatal(err)
	}
	admin, err := db.Authenticate(context.Background(), "root_admin", "very-secure-password")
	if err != nil {
		t.Fatal(err)
	}
	return admin
}

func formatID(id int64) string {
	return strconv.FormatInt(id, 10)
}

func serveGuildHTTPRequest(server *Server, token, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	request.AddCookie(&http.Cookie{Name: "test_session", Value: token})
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	return recorder
}
