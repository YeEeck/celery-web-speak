package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

const defaultGuildName = "Celery Web Speak"

func (s *Store) migrateGuilds(ctx context.Context) error {
	hasGuildID, err := s.tableHasColumn(ctx, "channels", "guild_id")
	if err != nil {
		return err
	}
	hasPlatformAdmin, err := s.tableHasColumn(ctx, "users", "is_platform_admin")
	if err != nil {
		return err
	}
	hasSuspendedAt, err := s.tableHasColumn(ctx, "users", "suspended_at")
	if err != nil {
		return err
	}
	hasAuditGuildID, err := s.tableHasColumn(ctx, "audit_logs", "guild_id")
	if err != nil {
		return err
	}
	if hasGuildID && hasPlatformAdmin && hasSuspendedAt && hasAuditGuildID {
		return nil
	}

	if _, err := s.db.ExecContext(ctx, "PRAGMA foreign_keys=OFF"); err != nil {
		return err
	}
	defer s.db.ExecContext(context.Background(), "PRAGMA foreign_keys=ON")

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if !hasPlatformAdmin {
		if _, err := tx.ExecContext(ctx, "ALTER TABLE users ADD COLUMN is_platform_admin INTEGER NOT NULL DEFAULT 0"); err != nil {
			return err
		}
	}
	if !hasSuspendedAt {
		if _, err := tx.ExecContext(ctx, "ALTER TABLE users ADD COLUMN suspended_at TEXT"); err != nil {
			return err
		}
	}
	if !hasAuditGuildID {
		if _, err := tx.ExecContext(ctx, "ALTER TABLE audit_logs ADD COLUMN guild_id INTEGER REFERENCES guilds(id) ON DELETE SET NULL"); err != nil {
			return err
		}
	}

	const guildSchema = `
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS guilds_owner_user_id ON guilds(owner_user_id);
CREATE INDEX IF NOT EXISTS guilds_created_at_id ON guilds(created_at, id);
CREATE TABLE IF NOT EXISTS guild_members (
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
  voice_muted INTEGER NOT NULL DEFAULT 0,
  text_muted INTEGER NOT NULL DEFAULT 0,
  permanently_banned INTEGER NOT NULL DEFAULT 0,
  temporary_ban_until TEXT,
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS guild_members_user_guild ON guild_members(user_id, guild_id);
CREATE INDEX IF NOT EXISTS guild_members_guild_role ON guild_members(guild_id, role, user_id);`
	if _, err := tx.ExecContext(ctx, guildSchema); err != nil {
		return err
	}

	var ownerID int64
	err = tx.QueryRowContext(ctx, `
SELECT id FROM users WHERE deleted_at IS NULL
ORDER BY CASE role WHEN 'server_admin' THEN 0 ELSE 1 END, created_at, id LIMIT 1`).Scan(&ownerID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var guildID int64
	if err == nil {
		now := formatTime(s.now())
		result, err := tx.ExecContext(ctx, `
INSERT INTO guilds (name, owner_user_id, created_by, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)`, defaultGuildName, ownerID, ownerID, now, now)
		if err != nil {
			return err
		}
		guildID, err = result.LastInsertId()
		if err != nil {
			return err
		}
		temporaryBanSelect := "NULL"
		temporaryBanJoin := ""
		if exists, tableErr := tableExistsTx(ctx, tx, "temporary_bans"); tableErr != nil {
			return tableErr
		} else if exists {
			temporaryBanSelect = "b.expires_at"
			temporaryBanJoin = " LEFT JOIN temporary_bans b ON b.user_id = u.id"
		}
		memberMigration := fmt.Sprintf(`
INSERT INTO guild_members (
  guild_id, user_id, role, voice_muted, text_muted, permanently_banned,
  temporary_ban_until, joined_at, updated_at
)
SELECT ?, u.id,
       CASE WHEN u.role IN ('server_admin', 'channel_admin') THEN 'admin' ELSE 'member' END,
	   u.voice_muted, u.text_muted, 0, %s, u.created_at, ?
FROM users u%s
WHERE u.deleted_at IS NULL`, temporaryBanSelect, temporaryBanJoin)
		if _, err := tx.ExecContext(ctx, memberMigration, guildID, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE users SET
  is_platform_admin = CASE WHEN role = 'server_admin' THEN 1 ELSE 0 END,
  suspended_at = CASE WHEN permanently_banned = 1 THEN COALESCE(suspended_at, updated_at) ELSE suspended_at END`); err != nil {
			return err
		}
	}

	if !hasGuildID {
		if guildID == 0 {
			if _, err := tx.ExecContext(ctx, "DELETE FROM channel_read_states; DELETE FROM messages; DELETE FROM channels"); err != nil {
				return err
			}
		}
		const rebuildChannels = `
CREATE TABLE channels_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('text','voice')),
  name TEXT NOT NULL COLLATE NOCASE,
  audio_bitrate_kbps INTEGER,
  message_retention INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  background_audio_bitrate_kbps INTEGER,
  audio_red_enabled INTEGER,
  background_audio_red_enabled INTEGER,
  UNIQUE(guild_id, type, name),
  CHECK(
    (type = 'text' AND audio_bitrate_kbps IS NULL AND message_retention BETWEEN 100 AND 5000)
    OR
    (type = 'voice' AND message_retention IS NULL AND audio_bitrate_kbps BETWEEN 32 AND 128 AND audio_bitrate_kbps % 8 = 0)
  )
);
INSERT INTO channels_new (
  id, guild_id, type, name, audio_bitrate_kbps, message_retention, created_at,
  updated_at, background_audio_bitrate_kbps, audio_red_enabled, background_audio_red_enabled
)
SELECT id, ?, type, name, audio_bitrate_kbps, message_retention, created_at,
       updated_at, background_audio_bitrate_kbps, audio_red_enabled, background_audio_red_enabled
FROM channels;
DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;
CREATE INDEX channels_guild_type_id ON channels(guild_id, type, id);`
		if _, err := tx.ExecContext(ctx, rebuildChannels, guildID); err != nil {
			return fmt.Errorf("rebuild channels for guilds: %w", err)
		}
	}
	if guildID != 0 {
		if err := insertAuditAt(ctx, tx, ownerID, nil, "migrate_managed_multi_server", "default_guild_id="+fmt.Sprint(guildID), s.now()); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE audit_logs SET guild_id = NULL WHERE action = 'migrate_managed_multi_server'"); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "PRAGMA user_version = 2"); err != nil {
		return err
	}
	return tx.Commit()
}
