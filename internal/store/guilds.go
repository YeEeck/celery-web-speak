package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrGuildOwnerCannotLeave = errors.New("guild owner cannot leave")
	ErrGuildMemberExists     = errors.New("guild member already exists")
	ErrGuildMemberBanned     = errors.New("guild member is banned")
)

func (s *Store) defaultGuildID(ctx context.Context) (int64, error) {
	var id int64
	err := s.db.QueryRowContext(ctx, "SELECT id FROM guilds ORDER BY id LIMIT 1").Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}

func (s *Store) ensureDefaultGuild(ctx context.Context, ownerID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM guilds").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return tx.Commit()
	}
	now := formatTime(s.now())
	result, err := tx.ExecContext(ctx, `INSERT INTO guilds (name, owner_user_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, defaultGuildName, ownerID, ownerID, now, now)
	if err != nil {
		return err
	}
	guildID, _ := result.LastInsertId()
	if _, err := tx.ExecContext(ctx, `INSERT INTO guild_members (guild_id, user_id, role, joined_at, updated_at) VALUES (?, ?, 'admin', ?, ?)`, guildID, ownerID, now, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET is_platform_admin = 1 WHERE id = ?`, ownerID); err != nil {
		return err
	}
	if err := createDefaultGuildChannels(ctx, tx, guildID, now); err != nil {
		return err
	}
	return tx.Commit()
}

func createDefaultGuildChannels(ctx context.Context, tx *sql.Tx, guildID int64, now string) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO channels (guild_id, type, name, message_retention, created_at, updated_at) VALUES (?, 'text', '文字聊天', 500, ?, ?)`, guildID, now, now); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO channels (guild_id, type, name, audio_bitrate_kbps, background_audio_bitrate_kbps, audio_red_enabled, background_audio_red_enabled, created_at, updated_at) VALUES (?, 'voice', '语音频道', 64, 128, 1, 0, ?, ?)`, guildID, now, now)
	return err
}

func (s *Store) GuildByID(ctx context.Context, guildID int64) (Guild, error) {
	return scanGuild(s.db.QueryRowContext(ctx, `SELECT id, name, owner_user_id, created_by, created_at, updated_at FROM guilds WHERE id = ?`, guildID))
}

func (s *Store) ListGuildsForUser(ctx context.Context, userID int64, platformAdmin bool) ([]GuildSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT g.id, g.name, g.owner_user_id, g.created_by, g.created_at, g.updated_at,
       gm.user_id IS NOT NULL,
       CASE WHEN g.owner_user_id = ? THEN 'owner' ELSE COALESCE(gm.role, '') END,
       CASE WHEN gm.user_id IS NOT NULL THEN (
         SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id
         LEFT JOIN channel_read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
         WHERE c.guild_id = g.id AND m.id > COALESCE(rs.last_read_message_id, 0)
       ) ELSE 0 END,
       CASE WHEN ? THEN (SELECT COUNT(*) FROM guild_members x WHERE x.guild_id = g.id) ELSE 0 END
FROM guilds g LEFT JOIN guild_members gm ON gm.guild_id = g.id AND gm.user_id = ?
WHERE (? OR gm.user_id IS NOT NULL)
ORDER BY CASE WHEN gm.user_id IS NOT NULL THEN gm.joined_at ELSE g.created_at END, g.id`, userID, userID, platformAdmin, userID, platformAdmin)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]GuildSummary, 0)
	for rows.Next() {
		var item GuildSummary
		var createdAt, updatedAt string
		if err := rows.Scan(&item.ID, &item.Name, &item.OwnerUserID, &item.CreatedBy, &createdAt, &updatedAt, &item.Joined, &item.Role, &item.UnreadCount, &item.MemberCount); err != nil {
			return nil, err
		}
		item.CreatedAt, _ = parseTime(createdAt)
		item.UpdatedAt, _ = parseTime(updatedAt)
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Store) GuildMembership(ctx context.Context, guildID, userID int64) (GuildMember, error) {
	return scanGuildMember(s.db.QueryRowContext(ctx, `
SELECT gm.guild_id, gm.user_id, u.username, u.display_name,
       CASE WHEN g.owner_user_id = gm.user_id THEN 'owner' ELSE gm.role END,
       gm.voice_muted, gm.text_muted, gm.permanently_banned, gm.temporary_ban_until, gm.joined_at
FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id JOIN users u ON u.id = gm.user_id AND u.deleted_at IS NULL
WHERE gm.guild_id = ? AND gm.user_id = ?`, guildID, userID))
}

func (s *Store) ListGuildMembers(ctx context.Context, guildID int64) ([]GuildMember, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT gm.guild_id, gm.user_id, u.username, u.display_name,
       CASE WHEN g.owner_user_id = gm.user_id THEN 'owner' ELSE gm.role END,
       gm.voice_muted, gm.text_muted, gm.permanently_banned, gm.temporary_ban_until, gm.joined_at
FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id JOIN users u ON u.id = gm.user_id
WHERE gm.guild_id = ? AND u.deleted_at IS NULL
ORDER BY CASE WHEN g.owner_user_id = gm.user_id THEN 0 WHEN gm.role = 'admin' THEN 1 ELSE 2 END, u.display_name COLLATE NOCASE`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := make([]GuildMember, 0)
	for rows.Next() {
		member, err := scanGuildMember(rows)
		if err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func (s *Store) CreateGuild(ctx context.Context, actorID int64, name, ownerUsername string) (Guild, error) {
	name = strings.TrimSpace(name)
	if len([]rune(name)) < 1 || len([]rune(name)) > 64 {
		return Guild{}, errors.New("guild name must contain 1 to 64 characters")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Guild{}, err
	}
	defer tx.Rollback()
	var ownerID int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE username = ? AND deleted_at IS NULL AND suspended_at IS NULL`, strings.TrimSpace(ownerUsername)).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return Guild{}, ErrNotFound
	}
	if err != nil {
		return Guild{}, err
	}
	now := formatTime(s.now())
	result, err := tx.ExecContext(ctx, `INSERT INTO guilds (name, owner_user_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, name, ownerID, actorID, now, now)
	if err != nil {
		return Guild{}, err
	}
	guildID, _ := result.LastInsertId()
	if _, err := tx.ExecContext(ctx, `INSERT INTO guild_members (guild_id, user_id, role, joined_at, updated_at) VALUES (?, ?, 'admin', ?, ?)`, guildID, ownerID, now, now); err != nil {
		return Guild{}, err
	}
	if err := createDefaultGuildChannels(ctx, tx, guildID, now); err != nil {
		return Guild{}, err
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, &ownerID, "create_guild", "name="+name); err != nil {
		return Guild{}, err
	}
	if err := tx.Commit(); err != nil {
		return Guild{}, err
	}
	return s.GuildByID(ctx, guildID)
}

func (s *Store) RenameGuild(ctx context.Context, guildID, actorID int64, name string) (Guild, error) {
	name = strings.TrimSpace(name)
	if len([]rune(name)) < 1 || len([]rune(name)) > 64 {
		return Guild{}, errors.New("guild name must contain 1 to 64 characters")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Guild{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "UPDATE guilds SET name = ?, updated_at = ? WHERE id = ?", name, formatTime(s.now()), guildID)
	if err != nil {
		return Guild{}, err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return Guild{}, ErrNotFound
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, nil, "rename_guild", "name="+name); err != nil {
		return Guild{}, err
	}
	if err := tx.Commit(); err != nil {
		return Guild{}, err
	}
	return s.GuildByID(ctx, guildID)
}

func (s *Store) AddGuildMember(ctx context.Context, guildID, actorID int64, username string) (GuildMember, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GuildMember{}, err
	}
	defer tx.Rollback()
	var userID int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE username = ? AND deleted_at IS NULL AND suspended_at IS NULL`, strings.TrimSpace(username)).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return GuildMember{}, ErrNotFound
	}
	if err != nil {
		return GuildMember{}, err
	}
	var banned int
	err = tx.QueryRowContext(ctx, "SELECT permanently_banned FROM guild_members WHERE guild_id = ? AND user_id = ?", guildID, userID).Scan(&banned)
	if err == nil {
		if banned != 0 {
			return GuildMember{}, ErrGuildMemberBanned
		}
		return GuildMember{}, ErrGuildMemberExists
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return GuildMember{}, err
	}
	now := formatTime(s.now())
	if _, err := tx.ExecContext(ctx, `INSERT INTO guild_members (guild_id, user_id, role, joined_at, updated_at) VALUES (?, ?, 'member', ?, ?)`, guildID, userID, now, now); err != nil {
		if isUniqueError(err) {
			return GuildMember{}, ErrGuildMemberExists
		}
		return GuildMember{}, err
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, &userID, "add_guild_member", ""); err != nil {
		return GuildMember{}, err
	}
	if err := tx.Commit(); err != nil {
		return GuildMember{}, err
	}
	return s.GuildMembership(ctx, guildID, userID)
}

func (s *Store) JoinGuildAsAdmin(ctx context.Context, guildID, userID int64) (GuildMember, error) {
	now := formatTime(s.now())
	_, err := s.db.ExecContext(ctx, `INSERT INTO guild_members (guild_id, user_id, role, joined_at, updated_at) VALUES (?, ?, 'admin', ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET role = 'admin', updated_at = excluded.updated_at WHERE guild_members.permanently_banned = 0`, guildID, userID, now, now)
	if err != nil {
		return GuildMember{}, err
	}
	return s.GuildMembership(ctx, guildID, userID)
}

func (s *Store) SetGuildMemberRole(ctx context.Context, guildID, actorID, userID int64, role GuildRole) (GuildMember, error) {
	if role != GuildRoleAdmin && role != GuildRoleMember {
		return GuildMember{}, errors.New("invalid guild role")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GuildMember{}, err
	}
	defer tx.Rollback()
	var ownerID int64
	if err := tx.QueryRowContext(ctx, "SELECT owner_user_id FROM guilds WHERE id = ?", guildID).Scan(&ownerID); errors.Is(err, sql.ErrNoRows) {
		return GuildMember{}, ErrNotFound
	} else if err != nil {
		return GuildMember{}, err
	}
	if userID == ownerID {
		return GuildMember{}, errors.New("cannot change guild owner role")
	}
	result, err := tx.ExecContext(ctx, "UPDATE guild_members SET role = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?", role, formatTime(s.now()), guildID, userID)
	if err != nil {
		return GuildMember{}, err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return GuildMember{}, ErrNotFound
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, &userID, "set_guild_member_role", string(role)); err != nil {
		return GuildMember{}, err
	}
	if err := tx.Commit(); err != nil {
		return GuildMember{}, err
	}
	return s.GuildMembership(ctx, guildID, userID)
}

func (s *Store) RemoveGuildMember(ctx context.Context, guildID, actorID, userID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var ownerID int64
	if err := tx.QueryRowContext(ctx, "SELECT owner_user_id FROM guilds WHERE id = ?", guildID).Scan(&ownerID); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if userID == ownerID {
		return ErrGuildOwnerCannotLeave
	}
	result, err := tx.ExecContext(ctx, "DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?", guildID, userID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, &userID, "remove_guild_member", ""); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) TransferGuildOwnership(ctx context.Context, guildID, actorID, newOwnerID int64) (Guild, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Guild{}, err
	}
	defer tx.Rollback()
	var oldOwnerID int64
	if err := tx.QueryRowContext(ctx, "SELECT owner_user_id FROM guilds WHERE id = ?", guildID).Scan(&oldOwnerID); errors.Is(err, sql.ErrNoRows) {
		return Guild{}, ErrNotFound
	} else if err != nil {
		return Guild{}, err
	}
	var active int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM guild_members WHERE guild_id = ? AND user_id = ? AND permanently_banned = 0 AND (temporary_ban_until IS NULL OR temporary_ban_until <= ?)`, guildID, newOwnerID, formatTime(s.now())).Scan(&active); err != nil {
		return Guild{}, err
	}
	if active == 0 {
		return Guild{}, ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, "UPDATE guild_members SET role = 'admin', updated_at = ? WHERE guild_id = ? AND user_id IN (?, ?)", formatTime(s.now()), guildID, oldOwnerID, newOwnerID); err != nil {
		return Guild{}, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE guilds SET owner_user_id = ?, updated_at = ? WHERE id = ?", newOwnerID, formatTime(s.now()), guildID); err != nil {
		return Guild{}, err
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, &newOwnerID, "transfer_guild_ownership", fmt.Sprintf("old_owner_id=%d", oldOwnerID)); err != nil {
		return Guild{}, err
	}
	if err := tx.Commit(); err != nil {
		return Guild{}, err
	}
	return s.GuildByID(ctx, guildID)
}

func (s *Store) DeleteGuild(ctx context.Context, guildID, actorID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var name string
	if err := tx.QueryRowContext(ctx, "SELECT name FROM guilds WHERE id = ?", guildID).Scan(&name); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	// Guild audit entries intentionally become platform-scoped snapshots after deletion.
	if _, err := tx.ExecContext(ctx, "UPDATE audit_logs SET guild_id = NULL, details = details || ? WHERE guild_id = ?", " guild_id="+fmt.Sprint(guildID)+" guild_name="+name, guildID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM guilds WHERE id = ?", guildID); err != nil {
		return err
	}
	if err := insertAudit(ctx, tx, actorID, nil, "delete_guild", fmt.Sprintf("guild_id=%d guild_name=%q", guildID, name)); err != nil {
		return err
	}
	return tx.Commit()
}

func insertGuildAudit(ctx context.Context, tx *sql.Tx, guildID, actorID int64, targetID *int64, action, details string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO audit_logs (actor_id, target_user_id, guild_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`, actorID, targetID, guildID, action, details, formatTime(time.Now().UTC()))
	return err
}

type guildScanner interface{ Scan(...any) error }

func scanGuild(scanner guildScanner) (Guild, error) {
	var guild Guild
	var createdAt, updatedAt string
	if err := scanner.Scan(&guild.ID, &guild.Name, &guild.OwnerUserID, &guild.CreatedBy, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Guild{}, ErrNotFound
		}
		return Guild{}, err
	}
	guild.CreatedAt, _ = parseTime(createdAt)
	guild.UpdatedAt, _ = parseTime(updatedAt)
	return guild, nil
}

func scanGuildMember(scanner guildScanner) (GuildMember, error) {
	var member GuildMember
	var voiceMuted, textMuted, permanentlyBanned int
	var temporaryBanUntil sql.NullString
	var joinedAt string
	if err := scanner.Scan(&member.GuildID, &member.UserID, &member.Username, &member.DisplayName, &member.Role, &voiceMuted, &textMuted, &permanentlyBanned, &temporaryBanUntil, &joinedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return GuildMember{}, ErrNotFound
		}
		return GuildMember{}, err
	}
	member.VoiceMuted = voiceMuted != 0
	member.TextMuted = textMuted != 0
	member.PermanentlyBanned = permanentlyBanned != 0
	member.JoinedAt, _ = parseTime(joinedAt)
	if temporaryBanUntil.Valid {
		until, err := parseTime(temporaryBanUntil.String)
		if err != nil {
			return GuildMember{}, fmt.Errorf("parse temporary ban: %w", err)
		}
		member.TemporaryBanUntil = &until
	}
	return member, nil
}
