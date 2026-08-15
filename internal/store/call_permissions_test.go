package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestSetUserCallReceivingTogglesOnUser(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()

	if err := db.SetUserCallReceiving(ctx, admin.ID, false); err != nil {
		t.Fatalf("disable call receiving: %v", err)
	}
	disabled, err := db.UserByID(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if disabled.CallReceiving {
		t.Fatal("CallReceiving = true after disable, want false")
	}

	if err := db.SetUserCallReceiving(ctx, admin.ID, true); err != nil {
		t.Fatalf("enable call receiving: %v", err)
	}
	enabled, err := db.UserByID(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !enabled.CallReceiving {
		t.Fatal("CallReceiving = false after enable, want true")
	}

	if err := db.SetUserCallReceiving(ctx, 999999, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing user error = %v, want ErrNotFound", err)
	}
}

func TestSetCallBlockPermanentActiveAndUpsert(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	target, err := db.CreateUser(context.Background(), "block_target", "屏蔽对象", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	base := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	db.now = func() time.Time { return base }

	block, err := db.SetCallBlock(ctx, admin.ID, target.ID, CallBlockKindPermanent)
	if err != nil {
		t.Fatalf("set permanent block: %v", err)
	}
	if block.Kind != CallBlockKindPermanent {
		t.Fatalf("block kind = %q, want permanent", block.Kind)
	}
	if block.ExpiresAt != nil {
		t.Fatalf("permanent block expiresAt = %v, want nil", block.ExpiresAt)
	}
	active, err := db.CallBlockActive(ctx, admin.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !active {
		t.Fatal("permanent block not active")
	}

	// Same pair upserted to temporary re-arms the 24h window.
	db.now = func() time.Time { return base.Add(time.Hour) }
	block, err = db.SetCallBlock(ctx, admin.ID, target.ID, CallBlockKindTemporary)
	if err != nil {
		t.Fatalf("upsert temporary block: %v", err)
	}
	wantExpiry := base.Add(time.Hour).Add(24 * time.Hour)
	if block.Kind != CallBlockKindTemporary || block.ExpiresAt == nil || !block.ExpiresAt.Equal(wantExpiry) {
		t.Fatalf("temporary block = %+v, want expires at %s", block, wantExpiry)
	}
	active, err = db.CallBlockActive(ctx, admin.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !active {
		t.Fatal("temporary block not active within window")
	}
}

func TestCallBlockActiveTreatsExpiredTemporaryAsInactive(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	target, err := db.CreateUser(context.Background(), "block_expired_target", "过期对象", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	base := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	db.now = func() time.Time { return base }
	if _, err := db.SetCallBlock(ctx, admin.ID, target.ID, CallBlockKindTemporary); err != nil {
		t.Fatal(err)
	}

	db.now = func() time.Time { return base.Add(24 * time.Hour) }
	active, err := db.CallBlockActive(ctx, admin.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if active {
		t.Fatal("expired temporary block still active")
	}
}

func TestCallBlockGetAndDelete(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	target, err := db.CreateUser(context.Background(), "block_get_target", "读取对象", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	base := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	db.now = func() time.Time { return base }

	block, exists, err := db.CallBlock(ctx, admin.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if exists || block.Kind != "" {
		t.Fatalf("missing block read = %+v exists=%v, want empty/absent", block, exists)
	}

	if _, err := db.SetCallBlock(ctx, admin.ID, target.ID, CallBlockKindTemporary); err != nil {
		t.Fatal(err)
	}
	block, exists, err = db.CallBlock(ctx, admin.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !exists || block.Kind != CallBlockKindTemporary {
		t.Fatalf("set block read = %+v exists=%v", block, exists)
	}

	if err := db.DeleteCallBlock(ctx, admin.ID, target.ID); err != nil {
		t.Fatal(err)
	}
	_, exists, err = db.CallBlock(ctx, admin.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("deleted block still exists")
	}

	// Deleting again is idempotent.
	if err := db.DeleteCallBlock(ctx, admin.ID, target.ID); err != nil {
		t.Fatalf("second delete: %v", err)
	}
}

func TestListCallBlocksReturnsActiveBlocksOrdered(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	base := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)

	soon := mustCreateUser(t, db, "block_list_soon", "最早到期")
	later := mustCreateUser(t, db, "block_list_later", "稍后到期")
	forever := mustCreateUser(t, db, "block_list_forever", "永久屏蔽")

	db.now = func() time.Time { return base }
	if _, err := db.SetCallBlock(ctx, admin.ID, soon.ID, CallBlockKindTemporary); err != nil {
		t.Fatal(err)
	}
	db.now = func() time.Time { return base.Add(time.Hour) }
	if _, err := db.SetCallBlock(ctx, admin.ID, later.ID, CallBlockKindTemporary); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetCallBlock(ctx, admin.ID, forever.ID, CallBlockKindPermanent); err != nil {
		t.Fatal(err)
	}

	blocks, err := db.ListCallBlocks(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 3 {
		t.Fatalf("block count = %d, want 3", len(blocks))
	}
	if blocks[0].UserID != soon.ID || blocks[1].UserID != later.ID || blocks[2].UserID != forever.ID {
		t.Fatalf("block order ids = [%d %d %d], want [%d %d %d]",
			blocks[0].UserID, blocks[1].UserID, blocks[2].UserID, soon.ID, later.ID, forever.ID)
	}
	if blocks[0].Username != soon.Username || blocks[0].DisplayName != soon.DisplayName {
		t.Fatalf("block entry identity = %+v, want target identity", blocks[0])
	}

	// After the first temporary window expires, only the later temporary and
	// the permanent blocks remain.
	db.now = func() time.Time { return base.Add(24*time.Hour + 30*time.Minute) }
	blocks, err = db.ListCallBlocks(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 2 || blocks[0].UserID != later.ID || blocks[1].UserID != forever.ID {
		t.Fatalf("post-expiry blocks = %+v, want [later forever]", blocks)
	}
}

func TestCallBlockCandidatesRequireSharedGuildAndPrefix(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	db.now = func() time.Time { return base }

	sharedByName := mustCreateUser(t, db, "alice_one", "一号")
	sharedByDisplay := mustCreateUser(t, db, "bob_two", "爱丽丝")
	blocked := mustCreateUser(t, db, "alice_blocked", "被屏蔽者")
	suspended := mustCreateUser(t, db, "alice_suspended", "停用者")
	outsider := mustCreateUser(t, db, "outsider_alice", "局外人")
	for _, user := range []User{sharedByName, sharedByDisplay, blocked, suspended} {
		if _, err := db.AddGuildMember(ctx, guildID, admin.ID, user.Username); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.db.ExecContext(ctx, "UPDATE users SET suspended_at = ? WHERE id = ?", formatTime(base), suspended.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetCallBlock(ctx, admin.ID, blocked.ID, CallBlockKindPermanent); err != nil {
		t.Fatal(err)
	}

	// Username prefix, case-insensitive; shared-guild only.
	candidates, err := db.CallBlockCandidates(ctx, admin.ID, "ALI")
	if err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for _, candidate := range candidates {
		ids = append(ids, candidate.UserID)
	}
	if len(ids) != 2 || ids[0] != sharedByName.ID || ids[1] != blocked.ID {
		t.Fatalf("username prefix candidates = %v, want [sharedByName blocked]", ids)
	}
	if candidates[1].Block == nil || candidates[1].Block.Kind != CallBlockKindPermanent {
		t.Fatalf("blocked candidate block = %+v, want permanent", candidates[1].Block)
	}

	// Display-name prefix also matches.
	candidates, err = db.CallBlockCandidates(ctx, admin.ID, "爱")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].UserID != sharedByDisplay.ID {
		t.Fatalf("display prefix candidates = %+v, want sharedByDisplay", candidates)
	}

	// Self and suspended users never appear.
	candidates, err = db.CallBlockCandidates(ctx, admin.ID, "root")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("self prefix candidates = %+v, want none", candidates)
	}
	candidates, err = db.CallBlockCandidates(ctx, admin.ID, "alice_s")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("suspended prefix candidates = %+v, want none", candidates)
	}

	// No shared guild → absent even with matching prefix.
	candidates, err = db.CallBlockCandidates(ctx, admin.ID, outsider.Username)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("outsider candidates = %+v, want none", candidates)
	}
}

func TestCallBlockCandidatesExcludePermanentlyBannedUser(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	banned := mustCreateUser(t, db, "block_banned_candidate", "封禁候选")
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, banned.Username); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(ctx, "UPDATE users SET permanently_banned = 1 WHERE id = ?", banned.ID); err != nil {
		t.Fatal(err)
	}

	candidates, err := db.CallBlockCandidates(ctx, admin.ID, "block_banned")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("permanently banned candidate leaked: %+v", candidates)
	}
}

func TestDeleteUserCascadesCallBlocks(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	target := mustCreateUser(t, db, "block_cascade_target", "级联目标")
	ctx := context.Background()
	if _, err := db.SetCallBlock(ctx, admin.ID, target.ID, CallBlockKindPermanent); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(ctx, "DELETE FROM users WHERE id = ?", target.ID); err != nil {
		t.Fatal(err)
	}

	blocks, err := db.ListCallBlocks(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 0 {
		t.Fatalf("cascade left blocks: %+v", blocks)
	}
}

func TestCallPermissionSchemaMigratesExistingDatabase(t *testing.T) {
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
	if _, err := raw.Exec("ALTER TABLE users DROP COLUMN call_receiving"); err != nil {
		raw.Close()
		t.Fatal(err)
	}
	if _, err := raw.Exec("DROP TABLE call_blocks"); err != nil {
		raw.Close()
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	ctx := context.Background()
	has, err := reopened.tableHasColumn(ctx, "users", "call_receiving")
	if err != nil {
		t.Fatal(err)
	}
	if !has {
		t.Fatal("call_receiving column was not recreated")
	}
	user, err := reopened.UserByID(ctx, bootstrapAdmin(t, reopened).ID)
	if err != nil {
		t.Fatal(err)
	}
	if !user.CallReceiving {
		t.Fatal("migrated call_receiving default is false, want true")
	}
}

func mustCreateUser(t *testing.T, db *Store, username, displayName string) User {
	t.Helper()
	user, err := db.CreateUser(context.Background(), username, displayName, "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	return user
}
