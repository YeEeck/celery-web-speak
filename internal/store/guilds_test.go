package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestBootstrapCreatesDefaultGuild(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()

	guilds, err := db.ListGuildsForUser(ctx, admin.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(guilds) != 1 || guilds[0].Name != defaultGuildName || !guilds[0].Joined || guilds[0].Role != GuildRoleOwner {
		t.Fatalf("default guild = %+v", guilds)
	}
	channels, err := db.ListGuildChannels(ctx, guilds[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(channels) != 2 || channels[0].GuildID != guilds[0].ID || channels[1].GuildID != guilds[0].ID {
		t.Fatalf("default channels = %+v", channels)
	}
}

func TestPlatformRegistrationDoesNotJoinGuild(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	invite, err := db.CreateInvite(ctx, admin.ID, 1, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	member, err := db.Register(ctx, invite.Code, "new_member", "新成员", "another-secure-password")
	if err != nil {
		t.Fatal(err)
	}
	guilds, err := db.ListGuildsForUser(ctx, member.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(guilds) != 0 {
		t.Fatalf("registered user guilds = %+v, want none", guilds)
	}
}

func TestGuildChannelNamesAreScoped(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	owner, err := db.CreateUser(ctx, "second_owner", "第二所有者", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	second, err := db.CreateGuild(ctx, admin.ID, "第二服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	firstID, err := db.defaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := db.CreateGuildChannel(ctx, firstID, admin.ID, ChannelTypeText, "同名频道"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateGuildChannel(ctx, second.ID, admin.ID, ChannelTypeText, "同名频道"); err != nil {
		t.Fatal(err)
	}
	firstChannels, err := db.ListGuildChannels(ctx, firstID)
	if err != nil {
		t.Fatal(err)
	}
	secondChannels, err := db.ListGuildChannels(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(firstChannels) != 3 || len(secondChannels) != 3 {
		t.Fatalf("channel counts = %d, %d", len(firstChannels), len(secondChannels))
	}
}

func TestGuildMembershipIsolation(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	owner, err := db.CreateUser(ctx, "guild_owner", "所有者", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	member, err := db.CreateUser(ctx, "guild_member", "成员", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	guild, err := db.CreateGuild(ctx, admin.ID, "隔离服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guild.ID, owner.ID, member.Username); err != nil {
		t.Fatal(err)
	}

	visible, err := db.ListGuildsForUser(ctx, member.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 1 || visible[0].ID != guild.ID {
		t.Fatalf("visible guilds = %+v", visible)
	}
	defaultID, err := db.defaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.GuildMembership(ctx, defaultID, member.ID); err != ErrNotFound {
		t.Fatalf("default membership error = %v", err)
	}
}

func TestGuildMessagesUseEffectiveServerRoles(t *testing.T) {
	db := newTestStore(t)
	platformAdmin := bootstrapAdmin(t, db)
	ctx := context.Background()
	owner, err := db.CreateUser(ctx, "message_owner", "消息所有者", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	guild, err := db.CreateGuild(ctx, platformAdmin.ID, "消息角色服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.JoinGuildAsAdmin(ctx, guild.ID, platformAdmin.ID); err != nil {
		t.Fatal(err)
	}
	channels, err := db.ListGuildChannels(ctx, guild.ID)
	if err != nil {
		t.Fatal(err)
	}
	var textChannel Channel
	for _, channel := range channels {
		if channel.Type == ChannelTypeText {
			textChannel = channel
			break
		}
	}
	ownerMessage, err := db.CreateGuildChannelMessage(ctx, guild.ID, textChannel.ID, owner, "所有者消息")
	if err != nil {
		t.Fatal(err)
	}
	adminMessage, err := db.CreateGuildChannelMessage(ctx, guild.ID, textChannel.ID, platformAdmin, "管理员消息")
	if err != nil {
		t.Fatal(err)
	}
	if ownerMessage.Role != GuildRoleOwner || adminMessage.Role != GuildRoleAdmin {
		t.Fatalf("created message roles = %q/%q", ownerMessage.Role, adminMessage.Role)
	}
	messages, _, err := db.ListGuildChannelMessages(ctx, guild.ID, textChannel.ID, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Role != GuildRoleOwner || messages[1].Role != GuildRoleAdmin {
		t.Fatalf("listed message roles = %+v", messages)
	}
}

func TestTransferGuildOwnershipRequiresActiveAccount(t *testing.T) {
	db := newTestStore(t)
	admin := bootstrapAdmin(t, db)
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}

	deleted, err := db.CreateUser(ctx, "deleted_owner_candidate", "已删除候选", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, deleted.Username); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteUser(ctx, admin.ID, deleted.ID, deleted.Username); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransferGuildOwnership(ctx, guildID, admin.ID, deleted.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("transfer to deleted account error = %v, want ErrNotFound", err)
	}

	suspended, err := db.CreateUser(ctx, "suspended_owner_candidate", "已停用候选", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, suspended.Username); err != nil {
		t.Fatal(err)
	}
	if err := db.SetPermanentBan(ctx, admin.ID, suspended.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransferGuildOwnership(ctx, guildID, admin.ID, suspended.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("transfer to suspended account error = %v, want ErrNotFound", err)
	}

	banned, err := db.CreateUser(ctx, "banned_owner_candidate", "服务器封禁候选", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, banned.Username); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, banned.ID, true, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransferGuildOwnership(ctx, guildID, admin.ID, banned.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("transfer to server-banned account error = %v, want ErrNotFound", err)
	}

	active, err := db.CreateUser(ctx, "active_owner_candidate", "有效候选", "another-secure-password", RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guildID, admin.ID, active.Username); err != nil {
		t.Fatal(err)
	}
	guild, err := db.TransferGuildOwnership(ctx, guildID, admin.ID, active.ID)
	if err != nil {
		t.Fatal(err)
	}
	if guild.OwnerUserID != active.ID {
		t.Fatalf("owner user ID = %d, want %d", guild.OwnerUserID, active.ID)
	}
	oldOwner, err := db.GuildMembership(ctx, guildID, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	newOwner, err := db.GuildMembership(ctx, guildID, active.ID)
	if err != nil {
		t.Fatal(err)
	}
	if oldOwner.Role != GuildRoleAdmin || newOwner.Role != GuildRoleOwner {
		t.Fatalf("roles after transfer = %q/%q, want admin/owner", oldOwner.Role, newOwner.Role)
	}
}
