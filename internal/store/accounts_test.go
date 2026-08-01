package store

import (
	"context"
	"errors"
	"testing"
)

func TestSetUserFixedAway(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()

	user, err := db.UserByID(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if user.FixedAway {
		t.Fatal("new users must default to auto mode")
	}

	if err := db.SetUserFixedAway(ctx, admin.ID, true); err != nil {
		t.Fatal(err)
	}
	user, err = db.UserByID(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !user.FixedAway {
		t.Fatal("fixed away setting did not persist")
	}

	auth, err := db.Authenticate(ctx, "root_admin", "very-secure-password")
	if err != nil {
		t.Fatal(err)
	}
	if !auth.FixedAway {
		t.Fatal("authenticate must carry the status setting")
	}

	if err := db.SetUserFixedAway(ctx, admin.ID, false); err != nil {
		t.Fatal(err)
	}
	user, err = db.UserByID(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if user.FixedAway {
		t.Fatal("switching back to auto mode must clear the setting")
	}

	if err := db.SetUserFixedAway(ctx, 999999, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing user = %v, want ErrNotFound", err)
	}
}

func TestUserFixedAwaySurvivesReopen(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/test.db"
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := db.EnsureBootstrapAdmin(ctx, "root_admin", "very-secure-password"); err != nil {
		t.Fatal(err)
	}
	admin, err := db.Authenticate(ctx, "root_admin", "very-secure-password")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetUserFixedAway(ctx, admin.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	user, err := db.UserByID(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !user.FixedAway {
		t.Fatal("status setting must survive a database reopen")
	}
}
