package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestProfileViewRequiresSharedGuild(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}

	outsider, err := db.CreateUser(ctx, "profile_outsider", "陌生人", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}

	// outsider asking for admin's profile → no shared guild.
	if _, err := db.ProfileView(ctx, outsider.ID, admin.ID, false); !errors.Is(err, ErrProfileNotInSharedGuild) {
		t.Fatalf("non-shared-guild profile read error = %v, want ErrProfileNotInSharedGuild", err)
	}

	// outsider can read their own profile.
	if _, err := db.ProfileView(ctx, outsider.ID, outsider.ID, false); err != nil {
		t.Fatalf("self profile read = %v", err)
	}

	// shared guild makes the read allowed.
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, outsider.Username); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ProfileView(ctx, outsider.ID, admin.ID, false); err != nil {
		t.Fatalf("shared-guild profile read = %v", err)
	}
}

func TestProfileViewPlatformAdminBypass(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()

	outsider, err := db.CreateUser(ctx, "profile_bypass_outsider", "路人", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	profile, err := db.ProfileView(ctx, admin.ID, outsider.ID, true)
	if err != nil {
		t.Fatalf("platform admin bypass read = %v", err)
	}
	if profile.ID != outsider.ID {
		t.Fatalf("profile id = %d, want %d", profile.ID, outsider.ID)
	}
}

func TestProfileViewNotFound(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	if _, err := db.ProfileView(ctx, admin.ID, 999999, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing target error = %v, want ErrNotFound", err)
	}
}

func TestGuildProfileViewRequiresRequesterMembership(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	outsider, err := db.CreateUser(ctx, "profile_guild_outsider", "局外人", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.GuildProfileView(ctx, outsider.ID, admin.ID, guildID); !errors.Is(err, ErrNotGuildMember) {
		t.Fatalf("non-member requester error = %v, want ErrNotGuildMember", err)
	}
	// Platform admin without membership gets no bypass in guild context.
	if _, err := db.db.ExecContext(ctx, "UPDATE users SET is_platform_admin = 1 WHERE id = ?", outsider.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GuildProfileView(ctx, outsider.ID, admin.ID, guildID); !errors.Is(err, ErrNotGuildMember) {
		t.Fatalf("non-member platform admin requester error = %v, want ErrNotGuildMember", err)
	}
}

func TestGuildProfileViewRejectsInactiveRequester(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, admin.ID, true, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GuildProfileView(ctx, admin.ID, admin.ID, guildID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("guild-banned requester error = %v, want ErrNotFound", err)
	}
}

func TestGuildProfileViewRejectsNonMemberTarget(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	target, err := db.CreateUser(ctx, "profile_guild_target", "路人", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.GuildProfileView(ctx, admin.ID, target.ID, guildID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-member target error = %v, want ErrNotFound", err)
	}
	if _, err := db.GuildProfileView(ctx, admin.ID, 999999, guildID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing target error = %v, want ErrNotFound", err)
	}
}

func TestGuildProfileViewRejectsInactiveTarget(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}

	target, err := db.CreateUser(ctx, "profile_inactive_target", "非活跃目标", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, target.Username); err != nil {
		t.Fatal(err)
	}

	// Guild-level permanent ban.
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, target.ID, true, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GuildProfileView(ctx, admin.ID, target.ID, guildID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("permanently banned target error = %v, want ErrNotFound", err)
	}

	// Guild-level temporary ban.
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, target.ID, false, nil); err != nil {
		t.Fatal(err)
	}
	until := db.now().Add(time.Hour)
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, target.ID, false, &until); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GuildProfileView(ctx, admin.ID, target.ID, guildID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("temporarily banned target error = %v, want ErrNotFound", err)
	}

	// Global suspension.
	if err := db.SetPermanentBan(ctx, admin.ID, target.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GuildProfileView(ctx, admin.ID, target.ID, guildID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("globally suspended target error = %v, want ErrNotFound", err)
	}
}

func TestGuildProfileViewReturnsVoiceFields(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AddGuildVoiceTime(ctx, guildID, admin.ID, 7200); err != nil {
		t.Fatal(err)
	}

	// Unscoped read carries no voice fields.
	global, err := db.ProfileView(ctx, admin.ID, admin.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if global.VoiceSecondsTotal != nil || global.VoiceXPTotal != nil || global.VoiceProgress != nil {
		t.Fatalf("unscoped read must not carry voice fields: %+v", global)
	}

	// Scoped read assembles voice seconds, XP and level progress.
	scoped, err := db.GuildProfileView(ctx, admin.ID, admin.ID, guildID)
	if err != nil {
		t.Fatal(err)
	}
	if scoped.VoiceSecondsTotal == nil || *scoped.VoiceSecondsTotal != 7200 {
		t.Fatalf("voiceSecondsTotal = %v, want 7200", scoped.VoiceSecondsTotal)
	}
	if scoped.VoiceXPTotal == nil || *scoped.VoiceXPTotal != 120 {
		t.Fatalf("voiceXpTotal = %v, want 120", scoped.VoiceXPTotal)
	}
	if scoped.VoiceProgress == nil {
		t.Fatalf("voiceProgress = nil, want {level=2,*}")
	}
	if got, want := scoped.VoiceProgress.XP, int64(120); got != want {
		t.Fatalf("voiceProgress.xp = %d, want %d", got, want)
	}
	if got, want := scoped.VoiceProgress.Level, int64(2); got != want {
		t.Fatalf("voiceProgress.level = %d, want %d", got, want)
	}
	if got, want := scoped.VoiceProgress.LevelStart, int64(120); got != want {
		t.Fatalf("voiceProgress.levelStartXp = %d, want %d", got, want)
	}
	if got, want := scoped.VoiceProgress.LevelEnd, int64(210); got != want {
		t.Fatalf("voiceProgress.levelEndXp = %d, want %d", got, want)
	}
}
