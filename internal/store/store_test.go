package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func bootstrapAdmin(t *testing.T, db *Store) User {
	t.Helper()
	if err := db.EnsureBootstrapAdmin(context.Background(), "root_admin", "very-secure-password"); err != nil {
		t.Fatal(err)
	}
	user, err := db.Authenticate(context.Background(), "root_admin", "very-secure-password")
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func TestInviteRegistrationAndUseLimit(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	invite, err := db.CreateInvite(ctx, admin.ID, 1, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	member, err := db.Register(ctx, invite.Code, "test_user", "测试用户", "another-secure-password")
	if err != nil {
		t.Fatal(err)
	}
	if member.Role != RoleMember {
		t.Fatalf("role = %q, want member", member.Role)
	}
	_, err = db.Register(ctx, invite.Code, "other_user", "另一用户", "another-secure-password")
	if !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("second use error = %v, want ErrInvalidInvite", err)
	}
}

func TestEmptyInviteListReturnsNonNilSlice(t *testing.T) {
	db := newTestStore(t)
	bootstrapAdmin(t, db)

	invites, cursor, err := db.ListInvites(context.Background(), nil, 30)
	if err != nil {
		t.Fatal(err)
	}
	if invites == nil {
		t.Fatal("empty invite list is nil, want non-nil empty slice")
	}
	if len(invites) != 0 || cursor != nil {
		t.Fatalf("empty invite list length/cursor = %d, %+v", len(invites), cursor)
	}
}

func TestInviteListPaginationAndOrdering(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	base := time.Date(2026, time.July, 20, 8, 0, 0, 0, time.UTC)
	db.now = func() time.Time { return base }

	expired, err := db.CreateInvite(ctx, admin.ID, 2, base.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	db.now = func() time.Time { return base.Add(10 * time.Minute) }
	revoked, err := db.CreateInvite(ctx, admin.ID, 2, base.Add(10*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RevokeInvite(ctx, admin.ID, revoked.ID); err != nil {
		t.Fatal(err)
	}
	db.now = func() time.Time { return base.Add(20 * time.Minute) }
	used, err := db.CreateInvite(ctx, admin.ID, 1, base.Add(12*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(ctx, "UPDATE invites SET use_count = max_uses WHERE id = ?", used.ID); err != nil {
		t.Fatal(err)
	}
	db.now = func() time.Time { return base.Add(30 * time.Minute) }
	later, err := db.CreateInvite(ctx, admin.ID, 2, base.Add(20*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	db.now = func() time.Time { return base.Add(40 * time.Minute) }
	sooner, err := db.CreateInvite(ctx, admin.ID, 2, base.Add(5*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	db.now = func() time.Time { return base.Add(2 * time.Hour) }

	first, cursor, err := db.ListInvites(ctx, nil, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || first[0].ID != sooner.ID || first[1].ID != later.ID {
		t.Fatalf("first page ids = %v, want [%d %d]", inviteIDs(first), sooner.ID, later.ID)
	}
	if first[0].Code != sooner.Code || cursor == nil || !cursor.Active {
		t.Fatalf("first page code/cursor = %q, %+v", first[0].Code, cursor)
	}

	second, cursor, err := db.ListInvites(ctx, cursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 2 || second[0].ID != used.ID || second[1].ID != revoked.ID {
		t.Fatalf("second page ids = %v, want [%d %d]", inviteIDs(second), used.ID, revoked.ID)
	}
	if cursor == nil || cursor.Active {
		t.Fatalf("second page cursor = %+v, want inactive cursor", cursor)
	}

	third, cursor, err := db.ListInvites(ctx, cursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(third) != 1 || third[0].ID != expired.ID || cursor != nil {
		t.Fatalf("third page ids/cursor = %v, %+v", inviteIDs(third), cursor)
	}
}

func TestDeleteInviteInvalidatesCode(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	invite, err := db.CreateInvite(ctx, admin.ID, 1, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteInvite(ctx, admin.ID, invite.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Register(ctx, invite.Code, "deleted_invite_user", "已删除邀请码", "another-secure-password"); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("register after delete error = %v, want ErrInvalidInvite", err)
	}
	if err := db.DeleteInvite(ctx, admin.ID, invite.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete error = %v, want ErrNotFound", err)
	}
	var auditCount int
	if err := db.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM audit_logs WHERE action = 'delete_invite' AND details = ?", "invite_id="+fmt.Sprint(invite.ID)).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("delete audit count = %d, want 1", auditCount)
	}
}

func TestInviteCodeColumnMigratesExistingDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec("ALTER TABLE invites DROP COLUMN code"); err != nil {
		raw.Close()
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	migrated, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	var codeColumns int
	if err := migrated.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('invites') WHERE name = 'code'`).Scan(&codeColumns); err != nil {
		t.Fatal(err)
	}
	if codeColumns != 1 {
		t.Fatalf("invite code column count = %d, want 1", codeColumns)
	}
}

func TestUserDeletedAtColumnMigratesExistingDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-users.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec("ALTER TABLE users DROP COLUMN deleted_at"); err != nil {
		raw.Close()
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	migrated, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	var columns int
	if err := migrated.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'deleted_at'`).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns != 1 {
		t.Fatalf("deleted_at column count = %d, want 1", columns)
	}
}

func inviteIDs(invites []Invite) []int64 {
	ids := make([]int64, len(invites))
	for index, invite := range invites {
		ids[index] = invite.ID
	}
	return ids
}

func TestServerTemporaryBanDoesNotInvalidatePlatformSession(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	member, err := db.CreateUser(ctx, "member_user", "成员", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := db.CreateSession(ctx, member.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.UserBySession(ctx, token); err != nil {
		t.Fatalf("session before ban: %v", err)
	}
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, member.Username); err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(30 * time.Minute)
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, member.ID, false, &until); err != nil {
		t.Fatal(err)
	}
	if _, err := db.UserBySession(ctx, token); err != nil {
		t.Fatalf("platform session after server ban: %v", err)
	}
	if _, err := db.Authenticate(ctx, member.Username, "another-secure-password"); err != nil {
		t.Fatalf("platform login during server ban: %v", err)
	}
}

func TestMessageRetention(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	text, err := db.FirstChannel(ctx, ChannelTypeText)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.UpdateChannel(ctx, admin.ID, text.ID, text.Name, 0, 0, false, false, 100); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 105; i++ {
		if _, err := db.CreateMessage(ctx, admin, "message"); err != nil {
			t.Fatal(err)
		}
	}
	messages, hasMore, err := db.ListMessages(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 100 {
		t.Fatalf("message count = %d, want 100", len(messages))
	}
	if hasMore {
		t.Fatal("retained message page unexpectedly has more messages")
	}
	if messages[0].ID != 6 {
		t.Fatalf("oldest message id = %d, want 6", messages[0].ID)
	}
	newestPage, hasMore, err := db.ListMessages(ctx, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(newestPage) != 50 || !hasMore {
		t.Fatalf("newest page count = %d, hasMore = %v; want 50, true", len(newestPage), hasMore)
	}
	olderPage, hasMore, err := db.ListMessages(ctx, newestPage[0].ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(olderPage) != 50 || hasMore {
		t.Fatalf("older page count = %d, hasMore = %v; want 50, false", len(olderPage), hasMore)
	}
}

func TestChannelsIsolateMessagesRetentionAndReadState(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	channels, err := db.ListChannels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(channels) != 2 || channels[0].Type != ChannelTypeText || channels[1].Type != ChannelTypeVoice {
		t.Fatalf("default channels = %+v", channels)
	}
	firstText := channels[0]
	secondText, err := db.CreateChannel(ctx, admin.ID, ChannelTypeText, "另一个文字频道")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.UpdateChannel(ctx, admin.ID, firstText.ID, firstText.Name, 0, 0, false, false, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := db.UpdateChannel(ctx, admin.ID, secondText.ID, secondText.Name, 0, 0, false, false, 100); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 105; index++ {
		if _, err := db.CreateChannelMessage(ctx, firstText.ID, admin, fmt.Sprintf("first-%d", index)); err != nil {
			t.Fatal(err)
		}
	}
	secondMessage, err := db.CreateChannelMessage(ctx, secondText.ID, admin, "second")
	if err != nil {
		t.Fatal(err)
	}
	firstMessages, _, err := db.ListChannelMessages(ctx, firstText.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	secondMessages, _, err := db.ListChannelMessages(ctx, secondText.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(firstMessages) != 100 || len(secondMessages) != 1 || secondMessages[0].ID != secondMessage.ID {
		t.Fatalf("isolated message counts = %d/%d", len(firstMessages), len(secondMessages))
	}

	states, err := db.ListChannelReadStates(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 2 || states[0].UnreadCount != 100 || states[0].LatestMessageID != firstMessages[len(firstMessages)-1].ID || states[1].UnreadCount != 1 || states[1].LatestMessageID != secondMessage.ID {
		t.Fatalf("initial read states = %+v", states)
	}
	state, err := db.MarkChannelRead(ctx, admin.ID, firstText.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.UnreadCount != 0 || state.LastReadMessageID != firstMessages[len(firstMessages)-1].ID || state.LatestMessageID != state.LastReadMessageID {
		t.Fatalf("marked read state = %+v", state)
	}
	states, err = db.ListChannelReadStates(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if states[0].UnreadCount != 0 || states[1].UnreadCount != 1 {
		t.Fatalf("updated read states = %+v", states)
	}
}

func TestVoiceChannelAudioSettings(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	channel, err := db.FirstChannel(ctx, ChannelTypeVoice)
	if err != nil {
		t.Fatal(err)
	}
	if channel.AudioBitrateKbps != 64 || channel.BackgroundAudioBitrateKbps != 128 || !channel.AudioRedEnabled || channel.BackgroundAudioRedEnabled {
		t.Fatalf("default voice audio settings = %+v", channel)
	}
	created, err := db.CreateChannel(ctx, admin.ID, ChannelTypeVoice, "另一个语音频道")
	if err != nil {
		t.Fatal(err)
	}
	if created.AudioBitrateKbps != 64 || created.BackgroundAudioBitrateKbps != 128 || !created.AudioRedEnabled || created.BackgroundAudioRedEnabled {
		t.Fatalf("created voice audio settings = %+v", created)
	}

	updated, err := db.UpdateChannel(ctx, admin.ID, channel.ID, channel.Name, 80, 160, false, true, 0)
	if err != nil {
		t.Fatal(err)
	}
	if updated.AudioBitrateKbps != 80 || updated.BackgroundAudioBitrateKbps != 160 || updated.AudioRedEnabled || !updated.BackgroundAudioRedEnabled {
		t.Fatalf("updated voice audio settings = %+v", updated)
	}
}

func TestChannelLifecycleProtectsLastTypeAndCascadesMessages(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	defaultText, err := db.FirstChannel(ctx, ChannelTypeText)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.DeleteChannel(ctx, admin.ID, defaultText.ID); !errors.Is(err, ErrLastChannel) {
		t.Fatalf("delete last text channel error = %v, want ErrLastChannel", err)
	}
	secondText, err := db.CreateChannel(ctx, admin.ID, ChannelTypeText, "临时频道")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateChannel(ctx, admin.ID, ChannelTypeText, "临时频道"); !errors.Is(err, ErrChannelNameExists) {
		t.Fatalf("duplicate channel error = %v, want ErrChannelNameExists", err)
	}
	message, err := db.CreateChannelMessage(ctx, secondText.ID, admin, "will be deleted")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MarkChannelRead(ctx, admin.ID, secondText.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.DeleteChannel(ctx, admin.ID, secondText.ID); err != nil {
		t.Fatal(err)
	}
	var messageCount, stateCount int
	if err := db.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM messages WHERE id = ?", message.ID).Scan(&messageCount); err != nil {
		t.Fatal(err)
	}
	if err := db.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM channel_read_states WHERE channel_id = ?", secondText.ID).Scan(&stateCount); err != nil {
		t.Fatal(err)
	}
	if messageCount != 0 || stateCount != 0 {
		t.Fatalf("cascaded message/read state counts = %d/%d", messageCount, stateCount)
	}
}

func TestClearTemporaryBanPreservesChannelReadState(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	member, err := db.CreateUser(ctx, "read_state_member", "已读状态成员", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	channel, err := db.FirstChannel(ctx, ChannelTypeText)
	if err != nil {
		t.Fatal(err)
	}
	message, err := db.CreateChannelMessage(ctx, channel.ID, admin, "封禁前已读")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MarkChannelRead(ctx, member.ID, channel.ID); err != nil {
		t.Fatal(err)
	}
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, member.Username); err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(time.Hour)
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, member.ID, false, &until); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ClearGuildMemberTemporaryBan(ctx, guildID, admin.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	states, err := db.ListChannelReadStates(ctx, member.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 1 || states[0].LastReadMessageID != message.ID || states[0].UnreadCount != 0 {
		t.Fatalf("read states after clearing temporary ban = %+v", states)
	}
}

func TestLegacyMessageMigrationPreservesAccountsAndDropsMessages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-channels.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	admin := bootstrapAdmin(t, db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`
DROP TABLE channel_read_states;
DROP TABLE messages;
DROP TABLE channels;
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  audio_bitrate_kbps INTEGER NOT NULL,
  message_retention INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO messages (user_id, content, created_at) VALUES (?, 'legacy', ?);
INSERT INTO settings VALUES (1, 64, 500, ?);`, admin.ID, formatTime(time.Now()), formatTime(time.Now())); err != nil {
		raw.Close()
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	migrated, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	if _, err := migrated.UserByID(context.Background(), admin.ID); err != nil {
		t.Fatalf("preserved user: %v", err)
	}
	channels, err := migrated.ListChannels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var messageCount, settingsTables, version int
	if err := migrated.db.QueryRow("SELECT COUNT(*) FROM messages").Scan(&messageCount); err != nil {
		t.Fatal(err)
	}
	if err := migrated.db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'settings'").Scan(&settingsTables); err != nil {
		t.Fatal(err)
	}
	if err := migrated.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if len(channels) != 2 || messageCount != 0 || settingsTables != 0 || version != 3 {
		t.Fatalf("migration result channels/messages/settings/version = %d/%d/%d/%d", len(channels), messageCount, settingsTables, version)
	}
}

func TestPermissionScopeMigrationConvergesAlreadyMigratedDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "permission-scope.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.EnsureBootstrapAdmin(context.Background(), "scope_admin", "very-secure-password"); err != nil {
		t.Fatal(err)
	}
	admin, err := db.Authenticate(context.Background(), "scope_admin", "very-secure-password")
	if err != nil {
		t.Fatal(err)
	}
	member, err := db.CreateUser(context.Background(), "legacy_channel_admin", "旧频道管理员", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	guildID, err := db.DefaultGuildID(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(context.Background(), guildID, admin.ID, member.Username); err != nil {
		t.Fatal(err)
	}
	legacyUntil := time.Now().Add(2 * time.Hour).UTC()
	if _, err := db.db.Exec("UPDATE users SET role = 'channel_admin', voice_muted = 1, text_muted = 1 WHERE id = ?", member.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.Exec(`CREATE TABLE temporary_bans (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.Exec(`INSERT INTO temporary_bans (user_id, expires_at, reason, created_by, created_at)
VALUES (?, ?, 'legacy', ?, ?)`, member.ID, formatTime(legacyUntil), admin.ID, formatTime(time.Now())); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	migrated, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	var role string
	var voiceMuted, textMuted, platformAdmin int
	if err := migrated.db.QueryRow("SELECT role, voice_muted, text_muted, is_platform_admin FROM users WHERE id = ?", member.ID).Scan(&role, &voiceMuted, &textMuted, &platformAdmin); err != nil {
		t.Fatal(err)
	}
	if role != "member" || voiceMuted != 0 || textMuted != 0 || platformAdmin != 0 {
		t.Fatalf("normalized user = role %q voice %d text %d platform %d", role, voiceMuted, textMuted, platformAdmin)
	}
	membership, err := migrated.GuildMembership(context.Background(), guildID, member.ID)
	if err != nil {
		t.Fatal(err)
	}
	if membership.Role != GuildRoleAdmin || !membership.VoiceMuted || !membership.TextMuted || membership.TemporaryBanUntil == nil || !membership.TemporaryBanUntil.Equal(legacyUntil) {
		t.Fatalf("migrated membership = %+v", membership)
	}
	if exists, err := migrated.tableExists(context.Background(), "temporary_bans"); err != nil || exists {
		t.Fatalf("temporary_bans exists = %t, error = %v", exists, err)
	}
}

func TestCannotDemoteLastPlatformAdmin(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	err := db.SetRole(context.Background(), admin.ID, admin.ID, RoleMember)
	if !errors.Is(err, ErrLastPlatformAdmin) {
		t.Fatalf("demote error = %v, want ErrLastPlatformAdmin", err)
	}
}

func TestSuspendedPlatformAdminDoesNotSatisfyLastAdminInvariant(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	second, err := db.CreateUser(ctx, "second_platform_admin", "第二管理员", "another-secure-password", RolePlatformAdmin)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetPermanentBan(ctx, admin.ID, second.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := db.SetRole(ctx, admin.ID, admin.ID, RoleMember); !errors.Is(err, ErrLastPlatformAdmin) {
		t.Fatalf("demote with only suspended replacement = %v, want ErrLastPlatformAdmin", err)
	}
	if err := db.SetPermanentBan(ctx, admin.ID, second.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := db.SetRole(ctx, admin.ID, admin.ID, RoleMember); err != nil {
		t.Fatalf("demote with active replacement: %v", err)
	}
}

func TestPlatformAdminCannotSuspendSelf(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	err := db.SetPermanentBan(context.Background(), admin.ID, admin.ID, true)
	if !errors.Is(err, ErrSelfAction) {
		t.Fatalf("self suspension error = %v, want ErrSelfAction", err)
	}
}

func TestDeleteUserAnonymizesAccountAndPreservesHistory(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	target, err := db.CreateUser(ctx, "delete_target", "待删除管理员", "another-secure-password", RolePlatformAdmin)
	if err != nil {
		t.Fatal(err)
	}
	defaultGuildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, defaultGuildID, admin.ID, target.Username); err != nil {
		t.Fatal(err)
	}
	invite, err := db.CreateInvite(ctx, target.ID, 2, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	message, err := db.CreateMessage(ctx, target, "删除后保留的消息")
	if err != nil {
		t.Fatal(err)
	}
	channel, err := db.FirstChannel(ctx, ChannelTypeText)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MarkChannelRead(ctx, target.ID, channel.ID); err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(30 * time.Minute)
	if _, err := db.SetGuildMemberBan(ctx, defaultGuildID, admin.ID, target.ID, false, &until); err != nil {
		t.Fatal(err)
	}
	token, _, err := db.CreateSession(ctx, target.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	if err := db.DeleteUser(ctx, admin.ID, target.ID, "wrong_username"); !errors.Is(err, ErrUsernameConfirm) {
		t.Fatalf("confirmation error = %v, want ErrUsernameConfirm", err)
	}
	if _, err := db.UserByID(ctx, target.ID); err != nil {
		t.Fatalf("target missing after rejected delete: %v", err)
	}
	if err := db.DeleteUser(ctx, admin.ID, target.ID, target.Username); err != nil {
		t.Fatal(err)
	}

	if _, err := db.UserByID(ctx, target.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("UserByID after delete error = %v, want ErrNotFound", err)
	}
	if _, err := db.Authenticate(ctx, target.Username, "another-secure-password"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("Authenticate after delete error = %v, want ErrInvalidLogin", err)
	}
	if _, err := db.UserBySession(ctx, token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("session after delete error = %v, want ErrNotFound", err)
	}
	var sessionCount, readStateCount int
	if err := db.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sessions WHERE user_id = ?", target.ID).Scan(&sessionCount); err != nil {
		t.Fatal(err)
	}
	if sessionCount != 0 {
		t.Fatalf("session count after delete = %d, want 0", sessionCount)
	}
	if err := db.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM channel_read_states WHERE user_id = ?", target.ID).Scan(&readStateCount); err != nil {
		t.Fatal(err)
	}
	if readStateCount != 0 {
		t.Fatalf("read state count after delete = %d, want 0", readStateCount)
	}
	if err := db.DeleteUser(ctx, admin.ID, target.ID, target.Username); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete error = %v, want ErrNotFound", err)
	}

	users, err := db.ListUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range users {
		if user.ID == target.ID {
			t.Fatal("deleted user remained in active user list")
		}
	}
	var storedUsername, displayName, passwordHash string
	var deletedAt sql.NullString
	if err := db.db.QueryRowContext(ctx, "SELECT username, display_name, password_hash, deleted_at FROM users WHERE id = ?", target.ID).
		Scan(&storedUsername, &displayName, &passwordHash, &deletedAt); err != nil {
		t.Fatal(err)
	}
	if storedUsername == target.Username || displayName != "已删除用户" || passwordHash != "" || !deletedAt.Valid {
		t.Fatalf("deleted row = username %q, display %q, password %q, deleted_at %q", storedUsername, displayName, passwordHash, deletedAt.String)
	}
	var temporaryBanTables int
	if err := db.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'temporary_bans'").Scan(&temporaryBanTables); err != nil {
		t.Fatal(err)
	}
	if temporaryBanTables != 0 {
		t.Fatalf("temporary ban table count = %d, want 0", temporaryBanTables)
	}
	var inviteCount, auditCount int
	if err := db.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM invites WHERE id = ? AND created_by = ?", invite.ID, target.ID).Scan(&inviteCount); err != nil {
		t.Fatal(err)
	}
	if err := db.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM audit_logs WHERE action = 'delete_user' AND target_user_id = ? AND details LIKE ?", target.ID, "%username=\"delete_target\"%").Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if inviteCount != 1 || auditCount != 1 {
		t.Fatalf("preserved invite/audit counts = %d/%d, want 1/1", inviteCount, auditCount)
	}
	messages, _, err := db.ListMessages(ctx, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].ID != message.ID || messages[0].Username != "" || messages[0].DisplayName != "已删除用户" || messages[0].Role != GuildRoleMember {
		t.Fatalf("message after delete = %+v", messages)
	}

	replacement, err := db.CreateUser(ctx, target.Username, "重新注册用户", "replacement-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if replacement.ID == target.ID {
		t.Fatal("replacement account reused deleted user ID")
	}
}

func TestDeleteUserRejectsSelf(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	err := db.DeleteUser(context.Background(), admin.ID, admin.ID, admin.Username)
	if !errors.Is(err, ErrSelfAction) {
		t.Fatalf("self delete error = %v, want ErrSelfAction", err)
	}
}
