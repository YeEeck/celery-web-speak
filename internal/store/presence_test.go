package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestSetGuildMemberVoiceXPRoleMatrix(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	platformAdmin := bootstrapAdmin(t, db)

	owner, err := db.CreateUser(ctx, "xp_matrix_owner", "经验矩阵所有者", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	guild, err := db.CreateGuild(ctx, platformAdmin.ID, "经验矩阵服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	ordinaryAdmin, err := db.CreateUser(ctx, "xp_matrix_admin", "经验矩阵管理员", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	member, err := db.CreateUser(ctx, "xp_matrix_member", "经验矩阵成员", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	outsider, err := db.CreateUser(ctx, "xp_matrix_outsider", "非成员用户", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range []User{ordinaryAdmin, member} {
		if _, err := db.AddGuildMember(ctx, guild.ID, owner.ID, user.Username); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.SetGuildMemberRole(ctx, guild.ID, owner.ID, ordinaryAdmin.ID, GuildRoleAdmin); err != nil {
		t.Fatal(err)
	}
	if _, err := db.JoinGuildAsAdmin(ctx, guild.ID, platformAdmin.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetGuildMemberRole(ctx, guild.ID, owner.ID, platformAdmin.ID, GuildRoleMember); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name   string
		actor  int64
		target int64
		want   error
	}{
		{"member actor", member.ID, member.ID, ErrGuildMemberVoiceXPForbidden},
		{"admin actor setting member", ordinaryAdmin.ID, member.ID, nil},
		{"admin actor setting admin", ordinaryAdmin.ID, ordinaryAdmin.ID, ErrGuildMemberVoiceXPForbidden},
		{"admin actor setting owner", ordinaryAdmin.ID, owner.ID, ErrGuildMemberVoiceXPForbidden},
		{"owner setting self", owner.ID, owner.ID, nil},
		{"owner setting member", owner.ID, member.ID, nil},
		{"platform admin setting member", platformAdmin.ID, member.ID, nil},
		{"platform admin setting admin", platformAdmin.ID, ordinaryAdmin.ID, nil},
		{"platform admin setting owner", platformAdmin.ID, owner.ID, ErrGuildMemberVoiceXPForbidden},
		{"non-member actor", outsider.ID, member.ID, ErrGuildMemberVoiceXPForbidden},
	} {
		_, err := db.SetGuildMemberVoiceXP(ctx, guild.ID, tc.actor, tc.target, 10)
		if !errors.Is(err, tc.want) {
			t.Fatalf("%s: error = %v, want %v", tc.name, err, tc.want)
		}
	}
}

func TestSetGuildMemberVoiceXPWritesAuditAndRejectsInactiveTargets(t *testing.T) {
	db := newTestStore(t)
	actor := bootstrapAdmin(t, db)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	target, err := db.CreateUser(ctx, "presence_xp_target", "经验审计目标", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, actor.ID, target.Username); err != nil {
		t.Fatal(err)
	}

	change, err := db.SetGuildMemberVoiceXP(ctx, guildID, actor.ID, target.ID, 120)
	if err != nil {
		t.Fatal(err)
	}
	if change.BeforeXP != 0 || change.AfterXP != 120 || change.Username != target.Username {
		t.Fatalf("xp change = %+v", change)
	}
	change, err = db.SetGuildMemberVoiceXP(ctx, guildID, actor.ID, target.ID, 120)
	if err != nil {
		t.Fatal(err)
	}
	if change.BeforeXP != 120 || change.AfterXP != 120 {
		t.Fatalf("same-value xp change = %+v", change)
	}

	var count int
	err = db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_logs
		WHERE guild_id = ? AND actor_id = ? AND target_user_id = ? AND action = ? AND details = ?`,
		guildID, actor.ID, target.ID, "set_guild_member_voice_xp", "before_xp=120 after_xp=120").Scan(&count)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("same-value audit count = %d, want 1", count)
	}

	if _, err := db.SetGuildMemberBan(ctx, guildID, actor.ID, target.ID, true, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetGuildMemberVoiceXP(ctx, guildID, actor.ID, target.ID, 150); !errors.Is(err, ErrNotFound) {
		t.Fatalf("inactive target error = %v, want ErrNotFound", err)
	}
	var afterInactiveAudit int
	err = db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_logs
		WHERE guild_id = ? AND actor_id = ? AND target_user_id = ? AND action = ? AND details = ?`,
		guildID, actor.ID, target.ID, "set_guild_member_voice_xp", fmt.Sprintf("before_xp=%d after_xp=%d", 120, 150)).Scan(&afterInactiveAudit)
	if err != nil {
		t.Fatal(err)
	}
	if afterInactiveAudit != 0 {
		t.Fatalf("inactive target wrote %d audit rows", afterInactiveAudit)
	}

	temporary, err := db.CreateUser(ctx, "presence_xp_temporary", "临时封禁目标", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, actor.ID, temporary.Username); err != nil {
		t.Fatal(err)
	}
	until := db.now().Add(time.Hour)
	if _, err := db.SetGuildMemberBan(ctx, guildID, actor.ID, temporary.ID, false, &until); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetGuildMemberVoiceXP(ctx, guildID, actor.ID, temporary.ID, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("temporary inactive target error = %v, want ErrNotFound", err)
	}

	globallySuspended, err := db.CreateUser(ctx, "presence_xp_global_suspend", "全局停用目标", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, actor.ID, globallySuspended.Username); err != nil {
		t.Fatal(err)
	}
	if err := db.SetPermanentBan(ctx, actor.ID, globallySuspended.ID, true); err != nil {
		t.Fatal(err)
	}
	if active, err := db.GuildMemberActive(ctx, guildID, globallySuspended.ID); err != nil {
		t.Fatal(err)
	} else if active {
		t.Fatal("globally suspended member reported active")
	}
	if _, err := db.SetGuildMemberVoiceXP(ctx, guildID, actor.ID, globallySuspended.ID, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("globally suspended target error = %v, want ErrNotFound", err)
	}

	suspendedOnly, err := db.CreateUser(ctx, "presence_xp_suspended_only", "仅停用目标", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, actor.ID, suspendedOnly.Username); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(ctx, "UPDATE users SET suspended_at = ? WHERE id = ?", formatTime(db.now()), suspendedOnly.ID); err != nil {
		t.Fatal(err)
	}
	if active, err := db.GuildMemberActive(ctx, guildID, suspendedOnly.ID); err != nil {
		t.Fatal(err)
	} else if active {
		t.Fatal("suspended-only member reported active")
	}
	if _, err := db.SetGuildMemberVoiceXP(ctx, guildID, actor.ID, suspendedOnly.ID, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("suspended-only target error = %v, want ErrNotFound", err)
	}
	for _, xp := range []int64{-1, MaxGuildMemberVoiceXP + 1} {
		if _, err := db.SetGuildMemberVoiceXP(ctx, guildID, actor.ID, target.ID, xp); !errors.Is(err, ErrInvalidGuildMemberVoiceXP) {
			t.Fatalf("invalid xp %d error = %v, want ErrInvalidGuildMemberVoiceXP", xp, err)
		}
	}

	members, err := db.ListGuildMembers(ctx, guildID)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range members {
		if member.UserID == globallySuspended.ID || member.UserID == suspendedOnly.ID {
			t.Fatalf("globally inactive member leaked from list: %+v", member)
		}
	}
}
