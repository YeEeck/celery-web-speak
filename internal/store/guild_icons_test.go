package store

import (
	"context"
	"errors"
	"testing"
)

func TestSetGuildIconBumpsVersionAndPersists(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()

	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	original, err := db.GuildByID(ctx, guildID)
	if err != nil {
		t.Fatal(err)
	}
	if original.IconVersion != 0 || original.HasIcon {
		t.Fatalf("fresh guild icon = %d/%t, want 0/false", original.IconVersion, original.HasIcon)
	}

	updated, err := db.SetGuildIcon(ctx, guildID, admin.ID, "image/png", []byte("png-bytes"))
	if err != nil {
		t.Fatalf("set guild icon: %v", err)
	}
	if updated.IconVersion != 1 || !updated.HasIcon {
		t.Fatalf("post-upload icon = %d/%t, want 1/true", updated.IconVersion, updated.HasIcon)
	}

	version, mime, bytes, ok, err := db.GetGuildIcon(ctx, guildID)
	if err != nil {
		t.Fatalf("get guild icon: %v", err)
	}
	if !ok || version != 1 || mime != "image/png" || string(bytes) != "png-bytes" {
		t.Fatalf("get guild icon = %d/%q/%q/%t", version, mime, string(bytes), ok)
	}
}

func TestClearGuildIconBumpsVersionAndKeepsMonotonic(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()

	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := db.SetGuildIcon(ctx, guildID, admin.ID, "image/webp", []byte("webp-bytes")); err != nil {
		t.Fatal(err)
	}
	afterUpload, err := db.GuildByID(ctx, guildID)
	if err != nil {
		t.Fatal(err)
	}

	cleared, err := db.ClearGuildIcon(ctx, guildID, admin.ID)
	if err != nil {
		t.Fatalf("clear guild icon: %v", err)
	}
	if cleared.IconVersion <= afterUpload.IconVersion {
		t.Fatalf("version after clear = %d, want > %d (monotonic, no reset)", cleared.IconVersion, afterUpload.IconVersion)
	}
	if cleared.HasIcon {
		t.Fatalf("hasIcon after clear = true, want false")
	}

	_, _, _, ok, err := db.GetGuildIcon(ctx, guildID)
	if err != nil {
		t.Fatalf("get guild icon after clear: %v", err)
	}
	if ok {
		t.Fatalf("ok after clear = true, want false")
	}

	if _, err := db.SetGuildIcon(ctx, guildID, admin.ID, "image/png", []byte("again")); err != nil {
		t.Fatal(err)
	}
	reuploaded, err := db.GuildByID(ctx, guildID)
	if err != nil {
		t.Fatal(err)
	}
	if reuploaded.IconVersion <= cleared.IconVersion {
		t.Fatalf("version after re-upload = %d, want > %d (no reset across clear/upload cycle)", reuploaded.IconVersion, cleared.IconVersion)
	}
}

func TestSetGuildIconUnknownGuildReturnsNotFound(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()

	_, err := db.SetGuildIcon(ctx, 999999, admin.ID, "image/png", []byte("x"))
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("set icon on missing guild err = %v, want ErrNotFound", err)
	}
	_, err = db.ClearGuildIcon(ctx, 999999, admin.ID)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("clear icon on missing guild err = %v, want ErrNotFound", err)
	}
	_, _, _, _, err = db.GetGuildIcon(ctx, 999999)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("get icon on missing guild err = %v, want ErrNotFound", err)
	}
}