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
SELECT u.id, u.username, u.display_name, u.role, u.voice_muted, u.text_muted,
       u.permanently_banned, u.created_at, b.expires_at
FROM users u LEFT JOIN temporary_bans b ON b.user_id = u.id
ORDER BY CASE u.role WHEN 'server_admin' THEN 0 WHEN 'channel_admin' THEN 1 ELSE 2 END,
         u.display_name COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var user User
		var voiceMuted, textMuted, permanentlyBanned int
		var createdAt string
		var banUntil sql.NullString
		if err := rows.Scan(&user.ID, &user.Username, &user.DisplayName, &user.Role, &voiceMuted, &textMuted, &permanentlyBanned, &createdAt, &banUntil); err != nil {
			return nil, err
		}
		user.VoiceMuted = voiceMuted != 0
		user.TextMuted = textMuted != 0
		user.PermanentlyBanned = permanentlyBanned != 0
		user.CreatedAt, _ = parseTime(createdAt)
		if banUntil.Valid {
			until, err := parseTime(banUntil.String)
			if err != nil {
				return nil, err
			}
			if until.After(s.now()) {
				user.TemporaryBanUntil = &until
			}
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (s *Store) SetMute(ctx context.Context, actorID, userID int64, voice, text bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
UPDATE users SET voice_muted = ?, text_muted = ?, updated_at = ? WHERE id = ?`,
		voice, text, formatTime(s.now()), userID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	details := fmt.Sprintf("voice=%t text=%t", voice, text)
	if err := insertAudit(ctx, tx, actorID, &userID, "set_mute", details); err != nil {
		return err
	}
	return tx.Commit()
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
	var current Role
	if err := tx.QueryRowContext(ctx, "SELECT role FROM users WHERE id = ?", userID).Scan(&current); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if current == RoleServerAdmin && role != RoleServerAdmin {
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM users WHERE role = 'server_admin'").Scan(&count); err != nil {
			return err
		}
		if count <= 1 {
			return ErrLastServerAdmin
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE users SET role = ?, updated_at = ? WHERE id = ?", role, formatTime(s.now()), userID); err != nil {
		return err
	}
	if err := insertAudit(ctx, tx, actorID, &userID, "set_role", string(role)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SetPermanentBan(ctx context.Context, actorID, userID int64, banned bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
UPDATE users SET permanently_banned = ?, updated_at = ? WHERE id = ?`, banned, formatTime(s.now()), userID); err != nil {
		return err
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

func (s *Store) SetTemporaryBan(ctx context.Context, actorID, userID int64, until time.Time, reason string) error {
	if !until.After(s.now()) || until.After(s.now().Add(365*24*time.Hour)) {
		return errors.New("temporary ban must end within one year")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
INSERT INTO temporary_bans (user_id, expires_at, reason, created_by, created_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at, reason=excluded.reason,
created_by=excluded.created_by, created_at=excluded.created_at`,
		userID, formatTime(until), reason, actorID, formatTime(s.now())); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE user_id = ?", userID); err != nil {
		return err
	}
	if err := insertAudit(ctx, tx, actorID, &userID, "temporary_ban", formatTime(until)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ClearTemporaryBan(ctx context.Context, actorID, userID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM temporary_bans WHERE user_id = ?", userID); err != nil {
		return err
	}
	if err := insertAudit(ctx, tx, actorID, &userID, "clear_temporary_ban", ""); err != nil {
		return err
	}
	return tx.Commit()
}

func insertAudit(ctx context.Context, tx *sql.Tx, actorID int64, targetID *int64, action, details string) error {
	_, err := tx.ExecContext(ctx, `
INSERT INTO audit_logs (actor_id, target_user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?)`,
		actorID, targetID, action, details, formatTime(time.Now().UTC()))
	return err
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
INSERT INTO invites (code_hash, created_by, max_uses, expires_at, created_at)
VALUES (?, ?, ?, ?, ?)`, hash[:], actorID, maxUses, formatTime(expiresAt), formatTime(now))
	if err != nil {
		return CreatedInvite{}, err
	}
	id, _ := result.LastInsertId()
	return CreatedInvite{Invite: Invite{ID: id, MaxUses: maxUses, ExpiresAt: expiresAt, CreatedAt: now, CreatedBy: actorID}, Code: code}, nil
}

func (s *Store) ListInvites(ctx context.Context) ([]Invite, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, created_by, max_uses, use_count, expires_at, revoked_at, created_at
FROM invites ORDER BY id DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var invites []Invite
	for rows.Next() {
		var invite Invite
		var expiresAt, createdAt string
		var revokedAt sql.NullString
		if err := rows.Scan(&invite.ID, &invite.CreatedBy, &invite.MaxUses, &invite.UseCount, &expiresAt, &revokedAt, &createdAt); err != nil {
			return nil, err
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

func (s *Store) RevokeInvite(ctx context.Context, actorID, inviteID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "UPDATE invites SET revoked_at = ? WHERE id = ?", formatTime(s.now()), inviteID); err != nil {
		return err
	}
	if err := insertAudit(ctx, tx, actorID, nil, "revoke_invite", fmt.Sprintf("invite_id=%d", inviteID)); err != nil {
		return err
	}
	return tx.Commit()
}
