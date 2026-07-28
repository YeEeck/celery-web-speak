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
	ErrNotFound                   = errors.New("not found")
	ErrInvalidLogin               = errors.New("invalid username or password")
	ErrUsernameExists             = errors.New("username already exists")
	ErrInvalidInvite              = errors.New("invite is invalid or expired")
	ErrBanned                     = errors.New("account is banned")
	ErrLastPlatformAdmin          = errors.New("at least one platform admin is required")
	ErrSelfAction                 = errors.New("cannot perform this action on yourself")
	ErrUsernameConfirm            = errors.New("username confirmation does not match")
	ErrLastChannel                = errors.New("at least one channel of each type is required")
	ErrChannelLimit               = errors.New("channel limit reached")
	ErrChannelNameExists          = errors.New("channel name already exists")
	ErrGuildOwnerTransferRequired = errors.New("guild ownership must be transferred first")
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
	if err := s.migrateChannels(ctx); err != nil {
		return fmt.Errorf("migrate channels: %w", err)
	}
	if err := s.ensureBackgroundAudioBitrateColumn(ctx); err != nil {
		return fmt.Errorf("migrate background audio bitrate: %w", err)
	}
	if err := s.ensureChannelRedColumns(ctx); err != nil {
		return fmt.Errorf("migrate channel RED settings: %w", err)
	}
	if err := s.migrateGuilds(ctx); err != nil {
		return fmt.Errorf("migrate managed multi-server: %w", err)
	}
	if err := s.migratePermissionScope(ctx); err != nil {
		return fmt.Errorf("migrate scoped permissions: %w", err)
	}
	if err := s.ensureAvatarColumns(ctx); err != nil {
		return fmt.Errorf("migrate avatar columns: %w", err)
	}
	return nil
}

func (s *Store) ensureAvatarColumns(ctx context.Context) error {
	for _, column := range []struct{ name, decl string }{
		{"avatar_version", "INTEGER NOT NULL DEFAULT 0"},
		{"avatar_bytes", "BLOB"},
		{"avatar_mime", "TEXT"},
	} {
		has, err := s.tableHasColumn(ctx, "users", column.name)
		if err != nil {
			return err
		}
		if !has {
			if _, err := s.db.ExecContext(ctx, "ALTER TABLE users ADD COLUMN "+column.name+" "+column.decl); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Store) migrateChannels(ctx context.Context) error {
	guildAware := false
	if exists, err := s.tableExists(ctx, "channels"); err != nil {
		return err
	} else if exists {
		guildAware, err = s.tableHasColumn(ctx, "channels", "guild_id")
		if err != nil {
			return err
		}
	}
	legacyMessages, err := s.tableExists(ctx, "messages")
	if err != nil {
		return err
	}
	legacySchema := false
	if legacyMessages {
		hasChannelID, err := s.tableHasColumn(ctx, "messages", "channel_id")
		if err != nil {
			return err
		}
		if !hasChannelID {
			legacySchema = true
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if legacySchema {
		if _, err := tx.ExecContext(ctx, "DROP TABLE messages"); err != nil {
			return fmt.Errorf("drop legacy messages: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, "DROP TABLE IF EXISTS settings"); err != nil {
		return fmt.Errorf("drop legacy settings: %w", err)
	}

	const schema = `
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('text','voice')),
  name TEXT NOT NULL COLLATE NOCASE,
  audio_bitrate_kbps INTEGER,
  message_retention INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(type, name),
  CHECK(
    (type = 'text' AND audio_bitrate_kbps IS NULL AND message_retention BETWEEN 100 AND 5000)
    OR
    (type = 'voice' AND message_retention IS NULL AND audio_bitrate_kbps BETWEEN 32 AND 128 AND audio_bitrate_kbps % 8 = 0)
  )
);
CREATE INDEX IF NOT EXISTS channels_type_id ON channels(type, id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_channel_id_id ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS channel_read_states (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_message_id INTEGER NOT NULL DEFAULT 0 CHECK(last_read_message_id >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, channel_id)
);`
	if _, err := tx.ExecContext(ctx, schema); err != nil {
		return err
	}
	if !guildAware {
		now := formatTime(s.now())
		if _, err := tx.ExecContext(ctx, `
INSERT INTO channels (type, name, message_retention, created_at, updated_at)
SELECT 'text', '文字聊天', 500, ?, ?
WHERE NOT EXISTS (SELECT 1 FROM channels WHERE type = 'text')`, now, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO channels (type, name, audio_bitrate_kbps, created_at, updated_at)
SELECT 'voice', '语音频道', 64, ?, ?
WHERE NOT EXISTS (SELECT 1 FROM channels WHERE type = 'voice')`, now, now); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "PRAGMA user_version = 2"); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) tableExists(ctx context.Context, table string) (bool, error) {
	var count int
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", table).Scan(&count)
	return count > 0, err
}

func (s *Store) tableHasColumn(ctx context.Context, table, column string) (bool, error) {
	rows, err := s.db.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
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

func (s *Store) ensureBackgroundAudioBitrateColumn(ctx context.Context) error {
	has, err := s.tableHasColumn(ctx, "channels", "background_audio_bitrate_kbps")
	if err != nil {
		return err
	}
	if !has {
		if _, err := s.db.ExecContext(ctx, "ALTER TABLE channels ADD COLUMN background_audio_bitrate_kbps INTEGER"); err != nil {
			return err
		}
	}
	_, err = s.db.ExecContext(ctx, "UPDATE channels SET background_audio_bitrate_kbps = 128 WHERE type = 'voice' AND background_audio_bitrate_kbps IS NULL")
	return err
}

func (s *Store) ensureChannelRedColumns(ctx context.Context) error {
	for _, column := range []string{"audio_red_enabled", "background_audio_red_enabled"} {
		has, err := s.tableHasColumn(ctx, "channels", column)
		if err != nil {
			return err
		}
		if !has {
			if _, err := s.db.ExecContext(ctx, "ALTER TABLE channels ADD COLUMN "+column+" INTEGER"); err != nil {
				return err
			}
		}
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE channels SET audio_red_enabled = 1 WHERE type = 'voice' AND audio_red_enabled IS NULL"); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, "UPDATE channels SET background_audio_red_enabled = 0 WHERE type = 'voice' AND background_audio_red_enabled IS NULL")
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
	admin, err := s.createUser(ctx, username, username, password, RolePlatformAdmin)
	if err != nil {
		return err
	}
	return s.ensureDefaultGuild(ctx, admin.ID)
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
INSERT INTO users (username, display_name, password_hash, role, is_platform_admin, created_at, updated_at)
VALUES (?, ?, ?, 'member', ?, ?, ?)`, username, displayName, string(hash), role == RolePlatformAdmin, now, now)
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
	var platformAdmin, permanentlyBanned, hasAvatar int
	err := s.db.QueryRowContext(ctx, `
SELECT id, username, display_name, password_hash, permanently_banned, created_at, is_platform_admin, avatar_version, avatar_bytes IS NOT NULL
FROM users WHERE username = ? AND deleted_at IS NULL`, strings.TrimSpace(username)).Scan(
		&user.ID, &user.Username, &user.DisplayName, &passwordHash,
		&permanentlyBanned, &createdAt, &platformAdmin,
		&user.AvatarVersion, &hasAvatar,
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
	user.PermanentlyBanned = permanentlyBanned != 0
	user.IsPlatformAdmin = platformAdmin != 0
	user.Role = platformRole(user.IsPlatformAdmin)
	user.HasAvatar = hasAvatar != 0
	user.CreatedAt, _ = parseTime(createdAt)
	if user.PermanentlyBanned {
		return User{}, ErrBanned
	}
	return user, nil
}

func (s *Store) UserByID(ctx context.Context, id int64) (User, error) {
	var user User
	var createdAt string
	var platformAdmin, permanentlyBanned, hasAvatar int
	err := s.db.QueryRowContext(ctx, `
SELECT id, username, display_name, permanently_banned, created_at, is_platform_admin, avatar_version, avatar_bytes IS NOT NULL
FROM users WHERE id = ? AND deleted_at IS NULL`, id).Scan(
		&user.ID, &user.Username, &user.DisplayName,
		&permanentlyBanned, &createdAt, &platformAdmin,
		&user.AvatarVersion, &hasAvatar,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("get user: %w", err)
	}
	user.PermanentlyBanned = permanentlyBanned != 0
	user.IsPlatformAdmin = platformAdmin != 0
	user.Role = platformRole(user.IsPlatformAdmin)
	user.HasAvatar = hasAvatar != 0
	user.CreatedAt, _ = parseTime(createdAt)
	return user, nil
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
	if user.PermanentlyBanned {
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
	return role == RoleMember || role == RolePlatformAdmin
}

func platformRole(admin bool) Role {
	if admin {
		return RolePlatformAdmin
	}
	return RoleMember
}
