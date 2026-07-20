package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

var (
	ErrNotFound        = errors.New("not found")
	ErrInvalidLogin    = errors.New("invalid username or password")
	ErrUsernameExists  = errors.New("username already exists")
	ErrInvalidInvite   = errors.New("invite is invalid or expired")
	ErrBanned          = errors.New("account is banned")
	ErrLastServerAdmin = errors.New("at least one server admin is required")
	ErrSelfAction      = errors.New("cannot perform this action on yourself")
	ErrUsernameConfirm = errors.New("username confirmation does not match")
)

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetConnMaxLifetime(0)

	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("configure sqlite: %w", err)
		}
	}

	s := &Store{db: db, now: func() time.Time { return time.Now().UTC() }}
	if err := s.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','channel_admin','server_admin')),
  voice_muted INTEGER NOT NULL DEFAULT 0,
  text_muted INTEGER NOT NULL DEFAULT 0,
  permanently_banned INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash BLOB NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash BLOB NOT NULL UNIQUE,
  code TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  max_uses INTEGER NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_active_order ON invites(revoked_at, expires_at, id);
CREATE INDEX IF NOT EXISTS invites_created_order ON invites(created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at);
CREATE TABLE IF NOT EXISTS temporary_bans (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  audio_bitrate_kbps INTEGER NOT NULL DEFAULT 64,
  message_retention INTEGER NOT NULL DEFAULT 500,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  target_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`
	if _, err := s.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate database: %w", err)
	}
	if err := s.ensureInviteCodeColumn(ctx); err != nil {
		return fmt.Errorf("migrate invite codes: %w", err)
	}
	if err := s.ensureUserDeletedAtColumn(ctx); err != nil {
		return fmt.Errorf("migrate deleted users: %w", err)
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO settings (id, audio_bitrate_kbps, message_retention, updated_at)
VALUES (1, 64, 500, ?)
ON CONFLICT(id) DO NOTHING`, formatTime(s.now()))
	if err != nil {
		return fmt.Errorf("initialize settings: %w", err)
	}
	return nil
}

func (s *Store) ensureUserDeletedAtColumn(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, "PRAGMA table_info(users)")
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return err
		}
		if name == "deleted_at" {
			return rows.Err()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, "ALTER TABLE users ADD COLUMN deleted_at TEXT")
	return err
}

func (s *Store) ensureInviteCodeColumn(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, "PRAGMA table_info(invites)")
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return err
		}
		if name == "code" {
			return rows.Err()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, "ALTER TABLE invites ADD COLUMN code TEXT")
	return err
}

func (s *Store) EnsureBootstrapAdmin(ctx context.Context, username, password string) error {
	var count int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM users WHERE deleted_at IS NULL").Scan(&count); err != nil {
		return fmt.Errorf("count users: %w", err)
	}
	if count > 0 {
		return nil
	}
	if err := validateUsername(username); err != nil || len(password) < 10 {
		return errors.New("empty database requires a valid BOOTSTRAP_ADMIN_USERNAME and a password of at least 10 characters")
	}
	_, err := s.createUser(ctx, username, username, password, RoleServerAdmin)
	return err
}

func (s *Store) createUser(ctx context.Context, username, displayName, password string, role Role) (User, error) {
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
	if !validRole(role) {
		return User{}, errors.New("invalid role")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return User{}, fmt.Errorf("hash password: %w", err)
	}
	now := formatTime(s.now())
	result, err := s.db.ExecContext(ctx, `
INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)`, username, displayName, string(hash), role, now, now)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return User{}, ErrUsernameExists
		}
		return User{}, fmt.Errorf("create user: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return User{}, fmt.Errorf("created user id: %w", err)
	}
	return s.UserByID(ctx, id)
}

func (s *Store) CreateUser(ctx context.Context, username, displayName, password string, role Role) (User, error) {
	return s.createUser(ctx, username, displayName, password, role)
}

func (s *Store) Authenticate(ctx context.Context, username, password string) (User, error) {
	var user User
	var passwordHash, createdAt string
	var voiceMuted, textMuted, permanentlyBanned int
	err := s.db.QueryRowContext(ctx, `
SELECT id, username, display_name, password_hash, role, voice_muted, text_muted,
       permanently_banned, created_at
FROM users WHERE username = ? AND deleted_at IS NULL`, strings.TrimSpace(username)).Scan(
		&user.ID, &user.Username, &user.DisplayName, &passwordHash, &user.Role,
		&voiceMuted, &textMuted, &permanentlyBanned, &createdAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrInvalidLogin
	}
	if err != nil {
		return User{}, fmt.Errorf("find user: %w", err)
	}
	if bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(password)) != nil {
		return User{}, ErrInvalidLogin
	}
	user.VoiceMuted = voiceMuted != 0
	user.TextMuted = textMuted != 0
	user.PermanentlyBanned = permanentlyBanned != 0
	user.CreatedAt, _ = parseTime(createdAt)
	if err := s.attachBan(ctx, &user); err != nil {
		return User{}, err
	}
	if user.PermanentlyBanned || (user.TemporaryBanUntil != nil && user.TemporaryBanUntil.After(s.now())) {
		return User{}, ErrBanned
	}
	return user, nil
}

func (s *Store) UserByID(ctx context.Context, id int64) (User, error) {
	var user User
	var createdAt string
	var voiceMuted, textMuted, permanentlyBanned int
	err := s.db.QueryRowContext(ctx, `
SELECT id, username, display_name, role, voice_muted, text_muted, permanently_banned, created_at
FROM users WHERE id = ? AND deleted_at IS NULL`, id).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.Role, &voiceMuted,
		&textMuted, &permanentlyBanned, &createdAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("get user: %w", err)
	}
	user.VoiceMuted = voiceMuted != 0
	user.TextMuted = textMuted != 0
	user.PermanentlyBanned = permanentlyBanned != 0
	user.CreatedAt, _ = parseTime(createdAt)
	if err := s.attachBan(ctx, &user); err != nil {
		return User{}, err
	}
	return user, nil
}

func (s *Store) attachBan(ctx context.Context, user *User) error {
	var expires string
	err := s.db.QueryRowContext(ctx, "SELECT expires_at FROM temporary_bans WHERE user_id = ?", user.ID).Scan(&expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("get temporary ban: %w", err)
	}
	until, err := parseTime(expires)
	if err != nil {
		return err
	}
	if until.After(s.now()) {
		user.TemporaryBanUntil = &until
	}
	return nil
}

func (s *Store) CreateSession(ctx context.Context, userID int64, ttl time.Duration) (string, time.Time, error) {
	token, err := randomToken(32)
	if err != nil {
		return "", time.Time{}, err
	}
	expires := s.now().Add(ttl)
	hash := hashToken(token)
	_, err = s.db.ExecContext(ctx, `
INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
		hash[:], userID, formatTime(expires), formatTime(s.now()))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("create session: %w", err)
	}
	return token, expires, nil
}

func (s *Store) UserBySession(ctx context.Context, token string) (User, error) {
	hash := hashToken(token)
	var userID int64
	err := s.db.QueryRowContext(ctx, `
SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?`, hash[:], formatTime(s.now())).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("find session: %w", err)
	}
	user, err := s.UserByID(ctx, userID)
	if err != nil {
		return User{}, err
	}
	if user.PermanentlyBanned || user.TemporaryBanUntil != nil {
		return User{}, ErrBanned
	}
	return user, nil
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	hash := hashToken(token)
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE token_hash = ?", hash[:])
	return err
}

func (s *Store) DeleteUserSessions(ctx context.Context, userID int64) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE user_id = ?", userID)
	return err
}

func hashToken(token string) [32]byte { return sha256.Sum256([]byte(token)) }

func randomToken(size int) (string, error) {
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate random token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func formatTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func parseTime(value string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse stored time: %w", err)
	}
	return t, nil
}

func validateUsername(value string) error {
	if len(value) < 3 || len(value) > 32 {
		return errors.New("username must contain 3 to 32 characters")
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && r != '_' && r != '-' {
			return errors.New("username may only contain letters, numbers, underscore and hyphen")
		}
	}
	return nil
}

func validateDisplayName(value string) error {
	if length := len([]rune(value)); length < 1 || length > 32 {
		return errors.New("display name must contain 1 to 32 characters")
	}
	return nil
}

func validatePassword(value string) error {
	if len(value) < 10 || len(value) > 128 {
		return errors.New("password must contain 10 to 128 characters")
	}
	return nil
}

func validRole(role Role) bool {
	return role == RoleMember || role == RoleChannelAdmin || role == RoleServerAdmin
}
