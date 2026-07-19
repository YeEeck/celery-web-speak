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

func inviteIDs(invites []Invite) []int64 {
	ids := make([]int64, len(invites))
	for index, invite := range invites {
		ids[index] = invite.ID
	}
	return ids
}

func TestSessionRejectedAfterTemporaryBan(t *testing.T) {
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
	if err := db.SetTemporaryBan(ctx, admin.ID, member.ID, time.Now().Add(30*time.Minute), "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.UserBySession(ctx, token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("session after ban error = %v, want ErrNotFound", err)
	}
	if _, err := db.Authenticate(ctx, member.Username, "another-secure-password"); !errors.Is(err, ErrBanned) {
		t.Fatalf("login during ban error = %v, want ErrBanned", err)
	}
}

func TestMessageRetention(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	if err := db.UpdateSettings(ctx, admin.ID, ChannelSettings{AudioBitrateKbps: 64, MessageRetention: 100}); err != nil {
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

func TestCannotDemoteLastServerAdmin(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	err := db.SetRole(context.Background(), admin.ID, admin.ID, RoleMember)
	if !errors.Is(err, ErrLastServerAdmin) {
		t.Fatalf("demote error = %v, want ErrLastServerAdmin", err)
	}
}

func TestSettingsValidation(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	tests := []ChannelSettings{
		{AudioBitrateKbps: 30, MessageRetention: 500},
		{AudioBitrateKbps: 65, MessageRetention: 500},
		{AudioBitrateKbps: 64, MessageRetention: 99},
		{AudioBitrateKbps: 64, MessageRetention: 5001},
	}
	for _, settings := range tests {
		if err := db.UpdateSettings(context.Background(), admin.ID, settings); err == nil {
			t.Fatalf("UpdateSettings(%+v) unexpectedly succeeded", settings)
		}
	}
}
