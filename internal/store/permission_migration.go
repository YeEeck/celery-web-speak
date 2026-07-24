package store

import (
	"context"
	"database/sql"
)

// migratePermissionScope is intentionally independent from the first guild
// migration so databases that already ran it still converge on one authority
// model on every upgrade.
func (s *Store) migratePermissionScope(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var defaultGuildID int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM guilds ORDER BY id LIMIT 1").Scan(&defaultGuildID); err != nil && err != sql.ErrNoRows {
		return err
	}
	hasTemporaryBans, err := tableExistsTx(ctx, tx, "temporary_bans")
	if err != nil {
		return err
	}
	if hasTemporaryBans && defaultGuildID > 0 {
		if _, err := tx.ExecContext(ctx, `
UPDATE guild_members
SET temporary_ban_until = (
  SELECT b.expires_at FROM temporary_bans b WHERE b.user_id = guild_members.user_id
), updated_at = ?
WHERE guild_id = ?
  AND EXISTS (
    SELECT 1 FROM temporary_bans b
    WHERE b.user_id = guild_members.user_id
      AND (guild_members.temporary_ban_until IS NULL OR b.expires_at > guild_members.temporary_ban_until)
  )`, formatTime(s.now()), defaultGuildID); err != nil {
			return err
		}
	}
	if defaultGuildID > 0 {
		if _, err := tx.ExecContext(ctx, `
UPDATE guild_members
SET role = CASE WHEN EXISTS (
      SELECT 1 FROM users u WHERE u.id = guild_members.user_id AND u.role = 'channel_admin'
    ) THEN 'admin' ELSE role END,
    voice_muted = MAX(voice_muted, COALESCE((
      SELECT u.voice_muted FROM users u WHERE u.id = guild_members.user_id
    ), 0)),
    text_muted = MAX(text_muted, COALESCE((
      SELECT u.text_muted FROM users u WHERE u.id = guild_members.user_id
    ), 0)),
    updated_at = ?
WHERE guild_id = ?`, formatTime(s.now()), defaultGuildID); err != nil {
			return err
		}
	}
	if hasTemporaryBans {
		if _, err := tx.ExecContext(ctx, "DROP TABLE temporary_bans"); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE users
SET role = 'member', voice_muted = 0, text_muted = 0,
    is_platform_admin = CASE WHEN is_platform_admin = 1 THEN 1 ELSE 0 END`); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "PRAGMA user_version = 3")
	if err != nil {
		return err
	}
	return tx.Commit()
}

func tableExistsTx(ctx context.Context, tx queryRower, table string) (bool, error) {
	var count int
	err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", table).Scan(&count)
	return count > 0, err
}

type queryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}
