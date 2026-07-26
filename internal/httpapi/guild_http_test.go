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

func TestGuildVoiceLeaveRequiresMembership(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	member, err := db.CreateUser(ctx, "voice_leave_member", "离开语音成员", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, member.Username); err != nil {
		t.Fatal(err)
	}
	token, _, err := db.CreateSession(ctx, member.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/guilds/"+formatID(guildID)+"/voice/leave", "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("guild voice leave = %d %s", recorder.Code, recorder.Body.String())
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
	recorder = serveGuildHTTPRequest(server, adminToken, http.MethodPost, "/api/guilds/"+formatID(other.ID)+"/voice/leave", "")
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "guild_membership_required") {
		t.Fatalf("unjoined guild voice leave = %d %s", recorder.Code, recorder.Body.String())
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

func TestGuildRenamePermissions(t *testing.T) {
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

	recorder := serveGuildHTTPRequest(server, adminToken, http.MethodPatch, "/api/platform/guilds/"+formatID(guild.ID), `{"name":"平台重命名"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("platform rename = %d %s", recorder.Code, recorder.Body.String())
	}
	updated, err := db.GuildByID(ctx, guild.ID)
	if err != nil || updated.Name != "平台重命名" {
		t.Fatalf("platform renamed guild = %#v, err = %v", updated, err)
	}

	recorder = serveGuildHTTPRequest(server, ownerToken, http.MethodPatch, "/api/platform/guilds/"+formatID(guild.ID), `{"name":"越权重命名"}`)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("non-platform rename = %d, want 403", recorder.Code)
	}

	recorder = serveGuildHTTPRequest(server, ownerToken, http.MethodPatch, "/api/guilds/"+formatID(guild.ID), `{"name":"所有者重命名"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("owner rename = %d %s", recorder.Code, recorder.Body.String())
	}
	updated, err = db.GuildByID(ctx, guild.ID)
	if err != nil || updated.Name != "所有者重命名" {
		t.Fatalf("owner renamed guild = %#v, err = %v", updated, err)
	}
}

func TestTemporarilyBannedPlatformAdminCannotRestoreGuildSubscription(t *testing.T) {
	db, owner, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	target, err := db.CreateUser(ctx, "temporarily_banned_admin", "临时封禁管理员", "another-secure-password", store.RolePlatformAdmin)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.JoinGuildAsAdmin(ctx, guildID, target.ID); err != nil {
		t.Fatal(err)
	}
	ownerToken, _, err := db.CreateSession(ctx, owner.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	targetToken, _, err := db.CreateSession(ctx, target.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	connection := newClient(target)
	connection.guilds[guildID] = struct{}{}
	server.hub.register(connection)
	t.Cleanup(func() { server.hub.unregister(connection, true) })

	until := time.Now().UTC().Add(time.Hour)
	banBody := `{"banned":false,"temporaryBanUntil":` + strconv.Quote(until.Format(time.RFC3339)) + `}`
	recorder := serveGuildHTTPRequest(server, ownerToken, http.MethodPatch, "/api/guilds/"+formatID(guildID)+"/members/"+formatID(target.ID)+"/ban", banBody)
	if recorder.Code != http.StatusOK {
		t.Fatalf("temporary ban = %d %s", recorder.Code, recorder.Body.String())
	}
	select {
	case <-connection.send:
	case <-time.After(time.Second):
		t.Fatal("temporarily banned client did not receive server removal")
	}

	recorder = serveGuildHTTPRequest(server, targetToken, http.MethodPost, "/api/platform/guilds/"+formatID(guildID)+"/join", "")
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "guild_member_banned") {
		t.Fatalf("join during temporary ban = %d %s", recorder.Code, recorder.Body.String())
	}
	server.hub.BroadcastGuild(guildID, "message_created", map[string]int64{"id": 1})
	select {
	case payload := <-connection.send:
		t.Fatalf("temporarily banned client received guild event: %s", payload)
	default:
	}

	bothBansBody := `{"banned":true,"temporaryBanUntil":` + strconv.Quote(until.Format(time.RFC3339)) + `}`
	recorder = serveGuildHTTPRequest(server, ownerToken, http.MethodPatch, "/api/guilds/"+formatID(guildID)+"/members/"+formatID(target.ID)+"/ban", bothBansBody)
	if recorder.Code != http.StatusOK {
		t.Fatalf("combined ban = %d %s", recorder.Code, recorder.Body.String())
	}
	select {
	case <-connection.send:
	case <-time.After(time.Second):
		t.Fatal("combined ban did not emit server removal")
	}
	recorder = serveGuildHTTPRequest(server, ownerToken, http.MethodDelete, "/api/guilds/"+formatID(guildID)+"/members/"+formatID(target.ID)+"/temporary-ban", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("clear temporary ban = %d %s", recorder.Code, recorder.Body.String())
	}
	server.hub.BroadcastGuild(guildID, "member_updated", map[string]int64{"userId": owner.ID})
	select {
	case payload := <-connection.send:
		t.Fatalf("permanently banned client received guild event after temporary clear: %s", payload)
	default:
	}
}

func TestGuildLifecycleEventsSynchronizeConnectedMembers(t *testing.T) {
	db, platformAdmin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	previousOwner, err := db.CreateUser(ctx, "lifecycle_previous_owner", "原所有者", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	newOwner, err := db.CreateUser(ctx, "lifecycle_new_owner", "新所有者", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	observer, err := db.CreateUser(ctx, "lifecycle_observer", "旁观成员", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	platformToken, _, err := db.CreateSession(ctx, platformAdmin.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	previousConnection := newClient(previousOwner)
	server.hub.register(previousConnection)
	t.Cleanup(func() { server.hub.unregister(previousConnection, true) })

	createBody := `{"name":"生命周期服务器","ownerUsername":` + strconv.Quote(previousOwner.Username) + `}`
	recorder := serveGuildHTTPRequest(server, platformToken, http.MethodPost, "/api/platform/guilds", createBody)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create guild = %d %s", recorder.Code, recorder.Body.String())
	}
	var created struct {
		Guild store.Guild `json:"guild"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	added := readClientEvents(t, previousConnection, 1)[0]
	if added.Type != "guild_added" || added.GuildID != created.Guild.ID {
		t.Fatalf("create event = %+v, want guild_added for %d", added, created.Guild.ID)
	}
	for _, member := range []store.User{newOwner, observer} {
		if _, err := db.AddGuildMember(ctx, created.Guild.ID, previousOwner.ID, member.Username); err != nil {
			t.Fatal(err)
		}
	}
	newConnection := newClient(newOwner)
	newConnection.guilds[created.Guild.ID] = struct{}{}
	server.hub.register(newConnection)
	t.Cleanup(func() { server.hub.unregister(newConnection, true) })
	observerConnection := newClient(observer)
	observerConnection.guilds[created.Guild.ID] = struct{}{}
	server.hub.register(observerConnection)
	t.Cleanup(func() { server.hub.unregister(observerConnection, true) })

	transferBody := `{"userId":` + formatID(newOwner.ID) + `}`
	recorder = serveGuildHTTPRequest(server, platformToken, http.MethodPatch, "/api/platform/guilds/"+formatID(created.Guild.ID)+"/owner", transferBody)
	if recorder.Code != http.StatusOK {
		t.Fatalf("transfer owner = %d %s", recorder.Code, recorder.Body.String())
	}
	for _, connection := range []*client{previousConnection, newConnection, observerConnection} {
		events := readClientEvents(t, connection, 3)
		if events[0].Type != "guild_updated" || events[1].Type != "member_updated" || events[2].Type != "member_updated" {
			t.Fatalf("transfer event types = %q/%q/%q", events[0].Type, events[1].Type, events[2].Type)
		}
		var updatedGuild store.Guild
		decodeEventData(t, events[0], &updatedGuild)
		if updatedGuild.OwnerUserID != newOwner.ID {
			t.Fatalf("updated owner ID = %d, want %d", updatedGuild.OwnerUserID, newOwner.ID)
		}
		var previousMember, newMember store.GuildMember
		decodeEventData(t, events[1], &previousMember)
		decodeEventData(t, events[2], &newMember)
		if previousMember.UserID != previousOwner.ID || previousMember.Role != store.GuildRoleAdmin {
			t.Fatalf("previous owner event = %+v", previousMember)
		}
		if newMember.UserID != newOwner.ID || newMember.Role != store.GuildRoleOwner {
			t.Fatalf("new owner event = %+v", newMember)
		}
	}
}

func TestGuildMembershipReconcilerRestoresPendingBanAfterRestart(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	target, err := db.CreateUser(ctx, "restart_restore_target", "重启恢复成员", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, target.Username); err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(100 * time.Millisecond)
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, target.ID, false, &until); err != nil {
		t.Fatal(err)
	}
	connection := newClient(target)
	server.hub.register(connection)
	t.Cleanup(func() { server.hub.unregister(connection, true) })
	reconcileContext, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go server.RunGuildMembershipReconciler(reconcileContext)

	events := readClientEvents(t, connection, 2)
	if events[0].Type != "guild_added" || events[0].GuildID != guildID || events[1].Type != "member_updated" {
		t.Fatalf("restore events = %+v", events)
	}
	member, err := db.GuildMembership(ctx, guildID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if member.TemporaryBanUntil != nil || !member.ActiveAt(time.Now()) {
		t.Fatalf("membership after restart restore = %+v", member)
	}
}

func TestStaleGuildMembershipRestoreTimerDoesNotOverrideExtendedBan(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	target, err := db.CreateUser(ctx, "extended_restore_target", "延期恢复成员", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, target.Username); err != nil {
		t.Fatal(err)
	}
	connection := newClient(target)
	server.hub.register(connection)
	t.Cleanup(func() { server.hub.unregister(connection, true) })
	firstUntil := time.Now().Add(100 * time.Millisecond)
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, target.ID, false, &firstUntil); err != nil {
		t.Fatal(err)
	}
	server.scheduleGuildMembershipRestore(&firstUntil)
	extendedUntil := time.Now().Add(350 * time.Millisecond)
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, target.ID, false, &extendedUntil); err != nil {
		t.Fatal(err)
	}
	server.scheduleGuildMembershipRestore(&extendedUntil)

	select {
	case payload := <-connection.send:
		t.Fatalf("stale timer restored extended ban: %s", payload)
	case <-time.After(200 * time.Millisecond):
	}
	events := readClientEvents(t, connection, 2)
	if events[0].Type != "guild_added" || events[1].Type != "member_updated" {
		t.Fatalf("extended restore events = %+v", events)
	}
}

func TestGuildMemberLeaveAndRemoval(t *testing.T) {
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

	recorder := serveGuildHTTPRequest(server, leavingToken, http.MethodPost, "/api/guilds/"+formatID(guildID)+"/leave", "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("member leave = %d %s", recorder.Code, recorder.Body.String())
	}
	if _, err := db.GuildMembership(ctx, guildID, leaving.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("leaving membership error = %v, want ErrNotFound", err)
	}

	recorder = serveGuildHTTPRequest(server, adminToken, http.MethodPost, "/api/guilds/"+formatID(guildID)+"/leave", "")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("owner leave = %d, want 400", recorder.Code)
	}

	recorder = serveGuildHTTPRequest(server, adminToken, http.MethodPost, "/api/guilds/"+formatID(guildID)+"/members/"+formatID(removed.ID)+"/kick", "")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("remove member = %d %s", recorder.Code, recorder.Body.String())
	}
	if _, err := db.GuildMembership(ctx, guildID, removed.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("removed membership error = %v, want ErrNotFound", err)
	}
}

func TestGuildAuthorizationDoesNotCrossGuildThroughLegacyOrScopedRoutes(t *testing.T) {
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
	guilds, err := db.ListGuildsForUser(ctx, admin.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	var defaultGuildID int64
	for _, item := range guilds {
		if item.ID != second.ID && item.Joined {
			defaultGuildID = item.ID
			break
		}
	}
	if defaultGuildID == 0 {
		t.Fatal("default guild not found")
	}
	if _, err := db.AddGuildMember(ctx, defaultGuildID, admin.ID, member.Username); err != nil {
		t.Fatal(err)
	}
	memberToken, _, err := db.CreateSession(ctx, member.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{
		"/api/channels/" + formatID(textChannel.ID) + "/messages",
		"/api/guilds/" + formatID(second.ID) + "/channels/" + formatID(textChannel.ID) + "/messages",
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
	req := httptest.NewRequest(http.MethodGet, "/api/guilds/"+formatID(second.ID)+"/bootstrap", nil)
	req.AddCookie(&http.Cookie{Name: "test_session", Value: adminToken})
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "guild_membership_required") {
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

func readClientEvents(t *testing.T, connection *client, count int) []event {
	t.Helper()
	events := make([]event, 0, count)
	for len(events) < count {
		select {
		case payload := <-connection.send:
			var item event
			if err := json.Unmarshal(payload, &item); err != nil {
				t.Fatalf("decode client event: %v", err)
			}
			events = append(events, item)
		case <-time.After(time.Second):
			t.Fatalf("received %d client events, want %d", len(events), count)
		}
	}
	return events
}

func decodeEventData(t *testing.T, item event, target any) {
	t.Helper()
	payload, err := json.Marshal(item.Data)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, target); err != nil {
		t.Fatal(err)
	}
}
