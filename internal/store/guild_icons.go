package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// SetGuildIcon stores the supplied icon bytes for the guild, atomically bumps
// icon_version so clients can cache by URL derivation of the version, and
// records a guild audit entry attributed to actorID.
func (s *Store) SetGuildIcon(ctx context.Context, guildID, actorID int64, mime string, bytes []byte) (Guild, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Guild{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
UPDATE guilds
SET icon_version = icon_version + 1, icon_bytes = ?, icon_mime = ?, updated_at = ?
WHERE id = ?`, bytes, mime, formatTime(s.now()), guildID)
	if err != nil {
		return Guild{}, fmt.Errorf("set guild icon: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return Guild{}, ErrNotFound
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, nil, "set_guild_icon", fmt.Sprintf("mime=%s bytes=%d", mime, len(bytes))); err != nil {
		return Guild{}, err
	}
	if err := tx.Commit(); err != nil {
		return Guild{}, err
	}
	return s.GuildByID(ctx, guildID)
}

// ClearGuildIcon removes the guild's icon bytes while still bumping icon_version
// so previously cached URLs cannot collide with a future upload, and records a
// guild audit entry attributed to actorID.
func (s *Store) ClearGuildIcon(ctx context.Context, guildID, actorID int64) (Guild, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Guild{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
UPDATE guilds
SET icon_version = icon_version + 1, icon_bytes = NULL, icon_mime = NULL, updated_at = ?
WHERE id = ?`, formatTime(s.now()), guildID)
	if err != nil {
		return Guild{}, fmt.Errorf("clear guild icon: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return Guild{}, ErrNotFound
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, nil, "clear_guild_icon", ""); err != nil {
		return Guild{}, err
	}
	if err := tx.Commit(); err != nil {
		return Guild{}, err
	}
	return s.GuildByID(ctx, guildID)
}

// GetGuildIcon returns the stored icon bytes, mime, monotonic version, and
// whether an icon is currently present for the guild.
func (s *Store) GetGuildIcon(ctx context.Context, guildID int64) (version int, mime string, bytes []byte, ok bool, err error) {
	var hasIcon int
	var mimeValue sql.NullString
	err = s.db.QueryRowContext(ctx, `
SELECT icon_version, icon_bytes IS NOT NULL, icon_bytes, icon_mime
FROM guilds WHERE id = ?`, guildID).Scan(&version, &hasIcon, &bytes, &mimeValue)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", nil, false, ErrNotFound
	}
	if err != nil {
		return 0, "", nil, false, fmt.Errorf("get guild icon: %w", err)
	}
	if mimeValue.Valid {
		mime = mimeValue.String
	}
	return version, mime, bytes, hasIcon != 0, nil
}