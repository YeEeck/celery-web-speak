package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

func (s *Store) Register(ctx context.Context, inviteCode, username, displayName, password string) (User, error) {
	username = strings.TrimSpace(username)
	displayName = strings.TrimSpace(displayName)
	if err := validateUsername(username); err != nil {
		return User{}, err
	}
	if err := validateDisplayName(displayName); err != nil {
		return User{}, err
	}
	if err := validatePassword(password); err != nil {
		return User{}, err
	}
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return User{}, fmt.Errorf("hash password: %w", err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()

	codeHash := hashToken(strings.TrimSpace(inviteCode))
	var inviteID int64
	err = tx.QueryRowContext(ctx, `
SELECT id FROM invites
WHERE code_hash = ? AND revoked_at IS NULL AND expires_at > ? AND use_count < max_uses`,
		codeHash[:], formatTime(s.now())).Scan(&inviteID)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrInvalidInvite
	}
	if err != nil {
		return User{}, fmt.Errorf("validate invite: %w", err)
	}

	now := formatTime(s.now())
	result, err := tx.ExecContext(ctx, `
INSERT INTO users (username, display_name, password_hash, role, is_platform_admin, created_at, updated_at)
VALUES (?, ?, ?, 'member', 0, ?, ?)`, username, displayName, string(passwordHash), now, now)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return User{}, ErrUsernameExists
		}
		return User{}, fmt.Errorf("register user: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "UPDATE invites SET use_count = use_count + 1 WHERE id = ?", inviteID); err != nil {
		return User{}, fmt.Errorf("consume invite: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit registration: %w", err)
	}
	id, _ := result.LastInsertId()
	return s.UserByID(ctx, id)
}

func (s *Store) UpdateProfile(ctx context.Context, userID int64, displayName, bio, currentPassword, newPassword string) (User, error) {
	displayName = strings.TrimSpace(displayName)
	if err := validateDisplayName(displayName); err != nil {
		return User{}, err
	}
	bio = strings.TrimSpace(bio)
	if err := validateBio(bio); err != nil {
		return User{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()

	if newPassword != "" {
		if err := validatePassword(newPassword); err != nil {
			return User{}, err
		}
		var existingHash string
		if err := tx.QueryRowContext(ctx, "SELECT password_hash FROM users WHERE id = ? AND deleted_at IS NULL", userID).Scan(&existingHash); err != nil {
			return User{}, err
		}
		if bcrypt.CompareHashAndPassword([]byte(existingHash), []byte(currentPassword)) != nil {
			return User{}, ErrInvalidLogin
		}
		newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
		if err != nil {
			return User{}, err
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE users SET display_name = ?, bio = ?, password_hash = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
			displayName, bio, string(newHash), formatTime(s.now()), userID); err != nil {
			return User{}, err
		}
	} else if _, err := tx.ExecContext(ctx, `
UPDATE users SET display_name = ?, bio = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, displayName, bio, formatTime(s.now()), userID); err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return s.UserByID(ctx, userID)
}

// SetUserFixedAway persists the user's status setting (固定离开) onto the
// account. It returns ErrNotFound when the account does not exist or is
// deleted. The platform online time pipeline is untouched.
func (s *Store) SetUserFixedAway(ctx context.Context, userID int64, fixedAway bool) error {
	value := 0
	if fixedAway {
		value = 1
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE users SET fixed_away = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, value, formatTime(s.now()), userID)
	if err != nil {
		return fmt.Errorf("set user fixed away: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ResetPassword(ctx context.Context, actorID, userID int64, password string) error {
	if err := validatePassword(password); err != nil {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", string(hash), formatTime(s.now()), userID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE user_id = ?", userID); err != nil {
		return err
	}
	if err := insertAudit(ctx, tx, actorID, &userID, "reset_password", ""); err != nil {
		return err
	}
	return tx.Commit()
}
