package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT u.id, u.username, u.display_name, u.permanently_banned, u.created_at,
       u.is_platform_admin, u.suspended_at
FROM users u
WHERE u.deleted_at IS NULL
ORDER BY u.is_platform_admin DESC,
         u.display_name COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var user User
		var permanentlyBanned, platformAdmin int
		var createdAt string
		var suspendedAt sql.NullString
		if err := rows.Scan(&user.ID, &user.Username, &user.DisplayName, &permanentlyBanned, &createdAt, &platformAdmin, &suspendedAt); err != nil {
			return nil, err
		}
		user.PermanentlyBanned = permanentlyBanned != 0
		user.IsPlatformAdmin = platformAdmin != 0
		user.Role = platformRole(user.IsPlatformAdmin)
		user.CreatedAt, _ = parseTime(createdAt)
		if suspendedAt.Valid {
			suspended, err := parseTime(suspendedAt.String)
			if err != nil {
				return nil, err
			}
			user.SuspendedAt = &suspended
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (s *Store) SetRole(ctx context.Context, actorID, userID int64, role Role) error {
	if !validRole(role) {
		return errors.New("invalid role")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var platformAdmin int
	var suspendedAt sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT is_platform_admin, suspended_at FROM users WHERE id = ? AND deleted_at IS NULL", userID).Scan(&platformAdmin, &suspendedAt); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if platformAdmin != 0 && !suspendedAt.Valid && role != RolePlatformAdmin {
		if err := requireAnotherActivePlatformAdmin(ctx, tx, userID); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE users SET role = 'member', is_platform_admin = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", role == RolePlatformAdmin, formatTime(s.now()), userID); err != nil {
		return err
	}
	if err := insertAudit(ctx, tx, actorID, &userID, "set_role", string(role)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SetPermanentBan(ctx context.Context, actorID, userID int64, banned bool) error {
	if banned && actorID == userID {
		return ErrSelfAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var platformAdmin int
	var suspendedAt sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT is_platform_admin, suspended_at FROM users WHERE id = ? AND deleted_at IS NULL", userID).Scan(&platformAdmin, &suspendedAt); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if banned && platformAdmin != 0 && !suspendedAt.Valid {
		if err := requireAnotherActivePlatformAdmin(ctx, tx, userID); err != nil {
			return err
		}
	}
	var suspensionValue any
	if banned {
		suspensionValue = formatTime(s.now())
	}
	result, err := tx.ExecContext(ctx, `
UPDATE users SET permanently_banned = ?, suspended_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, banned, suspensionValue, formatTime(s.now()), userID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	if banned {
		if _, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE user_id = ?", userID); err != nil {
			return err
		}
	}
	if err := insertAudit(ctx, tx, actorID, &userID, "set_permanent_ban", fmt.Sprintf("banned=%t", banned)); err != nil {
		return err
	}
	return tx.Commit()
}

func insertAudit(ctx context.Context, tx *sql.Tx, actorID int64, targetID *int64, action, details string) error {
	return insertAuditAt(ctx, tx, actorID, targetID, action, details, time.Now().UTC())
}

func insertAuditAt(ctx context.Context, tx *sql.Tx, actorID int64, targetID *int64, action, details string, createdAt time.Time) error {
	_, err := tx.ExecContext(ctx, `
INSERT INTO audit_logs (actor_id, target_user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?)`,
		actorID, targetID, action, details, formatTime(createdAt))
	return err
}

func (s *Store) DeleteUser(ctx context.Context, actorID, userID int64, confirmationUsername string) error {
	if actorID == userID {
		return ErrSelfAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var actorPlatformAdmin int
	if err := tx.QueryRowContext(ctx, "SELECT is_platform_admin FROM users WHERE id = ? AND deleted_at IS NULL", actorID).Scan(&actorPlatformAdmin); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if actorPlatformAdmin == 0 {
		return errors.New("platform admin role required")
	}

	var username string
	var platformAdmin int
	var suspendedAt sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT username, is_platform_admin, suspended_at FROM users WHERE id = ? AND deleted_at IS NULL", userID).Scan(&username, &platformAdmin, &suspendedAt); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if confirmationUsername != username {
		return ErrUsernameConfirm
	}
	var ownedGuilds int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM guilds WHERE owner_user_id = ?", userID).Scan(&ownedGuilds); err != nil {
		return err
	}
	if ownedGuilds > 0 {
		return ErrGuildOwnerTransferRequired
	}
	if platformAdmin != 0 && !suspendedAt.Valid {
		if err := requireAnotherActivePlatformAdmin(ctx, tx, userID); err != nil {
			return err
		}
	}

	now := s.now()
	deletedUsername := fmt.Sprintf("!deleted-user-%d", userID)
	result, err := tx.ExecContext(ctx, `
UPDATE users
SET username = ?, display_name = '已删除用户', password_hash = '', role = 'member',
    is_platform_admin = 0, voice_muted = 0, text_muted = 0, permanently_banned = 0,
    deleted_at = ?, updated_at = ?
WHERE id = ? AND deleted_at IS NULL`, deletedUsername, formatTime(now), formatTime(now), userID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM guild_members WHERE user_id = ?", userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE user_id = ?", userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM channel_read_states WHERE user_id = ?", userID); err != nil {
		return err
	}
	details := fmt.Sprintf("username=%q deleted_at=%s", username, formatTime(now))
	if err := insertAuditAt(ctx, tx, actorID, &userID, "delete_user", details, now); err != nil {
		return err
	}
	return tx.Commit()
}

func requireAnotherActivePlatformAdmin(ctx context.Context, tx *sql.Tx, excludedUserID int64) error {
	var count int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*) FROM users
WHERE is_platform_admin = 1 AND suspended_at IS NULL AND permanently_banned = 0
  AND deleted_at IS NULL AND id != ?`, excludedUserID).Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		return ErrLastPlatformAdmin
	}
	return nil
}

func (s *Store) CreateInvite(ctx context.Context, actorID int64, maxUses int, expiresAt time.Time) (CreatedInvite, error) {
	if maxUses < 1 || maxUses > 1000 {
		return CreatedInvite{}, errors.New("max uses must be between 1 and 1000")
	}
	if !expiresAt.After(s.now()) || expiresAt.After(s.now().Add(365*24*time.Hour)) {
		return CreatedInvite{}, errors.New("invite expiry must be within one year")
	}
	code, err := randomToken(18)
	if err != nil {
		return CreatedInvite{}, err
	}
	hash := hashToken(code)
	now := s.now()
	result, err := s.db.ExecContext(ctx, `
INSERT INTO invites (code_hash, code, created_by, max_uses, expires_at, created_at)
VALUES (?, ?, ?, ?, ?, ?)`, hash[:], code, actorID, maxUses, formatTime(expiresAt), formatTime(now))
	if err != nil {
		return CreatedInvite{}, err
	}
	id, _ := result.LastInsertId()
	return CreatedInvite{Invite: Invite{ID: id, Code: code, MaxUses: maxUses, ExpiresAt: expiresAt, CreatedAt: now, CreatedBy: actorID}}, nil
}

func (s *Store) ListInvites(ctx context.Context, cursor *InviteCursor, limit int) ([]Invite, *InviteCursor, error) {
	if limit < 1 || limit > 100 {
		limit = 30
	}
	now := formatTime(s.now())

	if cursor == nil || cursor.Active {
		active, err := s.queryInvites(ctx, true, cursor, limit+1, now)
		if err != nil {
			return nil, nil, err
		}
		if len(active) > limit {
			active = active[:limit]
			return active, inviteCursorFor(active[len(active)-1], true), nil
		}

		remaining := limit - len(active)
		inactive, err := s.queryInvites(ctx, false, nil, remaining+1, now)
		if err != nil {
			return nil, nil, err
		}
		if len(inactive) > remaining {
			if remaining == 0 {
				return active, inviteCursorFor(active[len(active)-1], true), nil
			}
			active = append(active, inactive[:remaining]...)
			return active, inviteCursorFor(active[len(active)-1], false), nil
		}
		return append(active, inactive...), nil, nil
	}

	inactive, err := s.queryInvites(ctx, false, cursor, limit+1, now)
	if err != nil {
		return nil, nil, err
	}
	if len(inactive) > limit {
		inactive = inactive[:limit]
		return inactive, inviteCursorFor(inactive[len(inactive)-1], false), nil
	}
	return inactive, nil, nil
}

func (s *Store) queryInvites(ctx context.Context, active bool, cursor *InviteCursor, limit int, now string) ([]Invite, error) {
	query := `
SELECT id, code, created_by, max_uses, use_count, expires_at, revoked_at, created_at
FROM invites
WHERE revoked_at IS NULL AND expires_at > ? AND use_count < max_uses`
	args := []any{now}
	if !active {
		query = `
SELECT id, code, created_by, max_uses, use_count, expires_at, revoked_at, created_at
FROM invites
WHERE NOT (revoked_at IS NULL AND expires_at > ? AND use_count < max_uses)`
	}
	if cursor != nil {
		if active {
			query += " AND (expires_at > ? OR (expires_at = ? AND id > ?))"
		} else {
			query += " AND (created_at < ? OR (created_at = ? AND id < ?))"
		}
		sortTime := formatTime(cursor.SortTime)
		args = append(args, sortTime, sortTime, cursor.ID)
	}
	if active {
		query += " ORDER BY expires_at ASC, id ASC LIMIT ?"
	} else {
		query += " ORDER BY created_at DESC, id DESC LIMIT ?"
	}
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	invites := make([]Invite, 0)
	for rows.Next() {
		var invite Invite
		var code, revokedAt sql.NullString
		var expiresAt, createdAt string
		if err := rows.Scan(&invite.ID, &code, &invite.CreatedBy, &invite.MaxUses, &invite.UseCount, &expiresAt, &revokedAt, &createdAt); err != nil {
			return nil, err
		}
		if code.Valid {
			invite.Code = code.String
		}
		invite.ExpiresAt, _ = parseTime(expiresAt)
		invite.CreatedAt, _ = parseTime(createdAt)
		if revokedAt.Valid {
			t, _ := parseTime(revokedAt.String)
			invite.RevokedAt = &t
		}
		invites = append(invites, invite)
	}
	return invites, rows.Err()
}

func inviteCursorFor(invite Invite, active bool) *InviteCursor {
	sortTime := invite.CreatedAt
	if active {
		sortTime = invite.ExpiresAt
	}
	return &InviteCursor{Active: active, SortTime: sortTime, ID: invite.ID}
}

func (s *Store) RevokeInvite(ctx context.Context, actorID, inviteID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?", formatTime(s.now()), inviteID)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return err
	} else if affected == 0 {
		return ErrNotFound
	}
	if err := insertAudit(ctx, tx, actorID, nil, "revoke_invite", fmt.Sprintf("invite_id=%d", inviteID)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DeleteInvite(ctx context.Context, actorID, inviteID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "DELETE FROM invites WHERE id = ?", inviteID)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return err
	} else if affected == 0 {
		return ErrNotFound
	}
	if err := insertAudit(ctx, tx, actorID, nil, "delete_invite", fmt.Sprintf("invite_id=%d", inviteID)); err != nil {
		return err
	}
	return tx.Commit()
}
