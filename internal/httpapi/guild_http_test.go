package httpapi

import (
	"context"
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
