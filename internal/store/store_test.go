package store

import (
	"context"
	"errors"
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
