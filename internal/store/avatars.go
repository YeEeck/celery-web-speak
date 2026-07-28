package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// SetAvatar stores the supplied avatar bytes for the user and atomically bumps
// avatar_version so clients can cache by URL derivation of the version.
func (s *Store) SetAvatar(ctx context.Context, userID int64, mime string, bytes []byte) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
UPDATE users
SET avatar_version = avatar_version + 1, avatar_bytes = ?, avatar_mime = ?, updated_at = ?
WHERE id = ? AND deleted_at IS NULL`, bytes, mime, formatTime(s.now()), userID)
	if err != nil {
		return User{}, fmt.Errorf("set avatar: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return User{}, ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return s.UserByID(ctx, userID)
}

// ClearAvatar removes the user's avatar bytes while still bumping avatar_version
// so previously cached URLs cannot collide with a future upload.
func (s *Store) ClearAvatar(ctx context.Context, userID int64) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
UPDATE users
SET avatar_version = avatar_version + 1, avatar_bytes = NULL, avatar_mime = NULL, updated_at = ?
WHERE id = ? AND deleted_at IS NULL`, formatTime(s.now()), userID)
	if err != nil {
		return User{}, fmt.Errorf("clear avatar: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return User{}, ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return s.UserByID(ctx, userID)
}

// GetAvatar returns the stored avatar bytes, mime, monotonic version, and
// whether an avatar is currently present for the user.
func (s *Store) GetAvatar(ctx context.Context, userID int64) (version int, mime string, bytes []byte, ok bool, err error) {
	var hasAvatar int
	var mimeValue sql.NullString
	err = s.db.QueryRowContext(ctx, `
SELECT avatar_version, avatar_bytes IS NOT NULL, avatar_bytes, avatar_mime
FROM users WHERE id = ? AND deleted_at IS NULL`, userID).Scan(&version, &hasAvatar, &bytes, &mimeValue)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", nil, false, ErrNotFound
	}
	if err != nil {
		return 0, "", nil, false, fmt.Errorf("get avatar: %w", err)
	}
	if mimeValue.Valid {
		mime = mimeValue.String
	}
	return version, mime, bytes, hasAvatar != 0, nil
}