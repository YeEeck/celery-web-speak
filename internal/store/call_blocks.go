package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// CallBlockKind is the persistence kind of a 呼叫屏蔽: temporary blocks expire
// 24h after they are set; permanent blocks never expire on their own.
type CallBlockKind string

const (
	CallBlockKindTemporary CallBlockKind = "temporary"
	CallBlockKindPermanent CallBlockKind = "permanent"
)

// CallBlock is the effective permission state between an owner and a target.
type CallBlock struct {
	Kind      CallBlockKind `json:"kind"`
	ExpiresAt *time.Time    `json:"expiresAt,omitempty"`
}

// sharedGuildTx is the transactional twin of SharedGuild: the same predicate
// run inside an open transaction, so the check and the subsequent write are
// atomic (ADR-0021：策略唯一收归于 store 事务，消除 handler 预检的 TOCTOU)。
func (s *Store) sharedGuildTx(ctx context.Context, tx *sql.Tx, userID, otherUserID int64) (bool, error) {
	var count int
	err := tx.QueryRowContext(ctx, `
SELECT COUNT(*) FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id
WHERE a.user_id = ? AND b.user_id = ?`, userID, otherUserID).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("check shared guild: %w", err)
	}
	return count > 0, nil
}

// SetCallBlock upserts the owner's call block on target. The target must be an
// existing non-deleted user; first-time setup additionally requires a shared
// guild (spec：首次设置时双方必须共享至少一个服务器；已存在屏蔽时，修改与
// 解除不要求当前仍共享服务器). Setting a temporary block starts a fresh 24h
// window; setting a permanent block clears the expiry. Returns ErrNotFound
// when the target is missing and ErrNotInSharedGuild on first setup without a
// shared guild. All checks and the upsert run in one transaction.
func (s *Store) SetCallBlock(ctx context.Context, ownerID, targetID int64, kind CallBlockKind) (CallBlock, error) {
	if kind != CallBlockKindTemporary && kind != CallBlockKindPermanent {
		return CallBlock{}, fmt.Errorf("invalid call block kind %q", kind)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return CallBlock{}, fmt.Errorf("begin set call block: %w", err)
	}
	defer tx.Rollback()

	var one int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL`, targetID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return CallBlock{}, ErrNotFound
	}
	if err != nil {
		return CallBlock{}, fmt.Errorf("check call block target: %w", err)
	}

	// 首次设置要求共享服务器；已有屏蔽行的修改不再要求（spec 设置条件）。
	var hasBlock int
	err = tx.QueryRowContext(ctx, `
SELECT 1 FROM call_blocks WHERE owner_user_id = ? AND target_user_id = ?`,
		ownerID, targetID).Scan(&hasBlock)
	if errors.Is(err, sql.ErrNoRows) {
		shared, err := s.sharedGuildTx(ctx, tx, ownerID, targetID)
		if err != nil {
			return CallBlock{}, err
		}
		if !shared {
			return CallBlock{}, ErrNotInSharedGuild
		}
	} else if err != nil {
		return CallBlock{}, fmt.Errorf("check existing call block: %w", err)
	}

	now := s.now()
	var expiresAt *time.Time
	if kind == CallBlockKindTemporary {
		expiry := now.Add(24 * time.Hour)
		expiresAt = &expiry
	}
	var expiresValue any
	if expiresAt != nil {
		expiresValue = formatTime(*expiresAt)
	}
	nowValue := formatTime(now)
	if _, err := tx.ExecContext(ctx, `
INSERT INTO call_blocks (owner_user_id, target_user_id, kind, expires_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(owner_user_id, target_user_id) DO UPDATE SET
  kind = excluded.kind,
  expires_at = excluded.expires_at,
  updated_at = excluded.updated_at`,
		ownerID, targetID, string(kind), expiresValue, nowValue, nowValue); err != nil {
		return CallBlock{}, fmt.Errorf("set call block: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return CallBlock{}, fmt.Errorf("commit set call block: %w", err)
	}
	return CallBlock{Kind: kind, ExpiresAt: expiresAt}, nil
}

// CallBlockActive reports whether an unexpired block from owner onto target
// exists. Expired temporary rows are treated as absent.
func (s *Store) CallBlockActive(ctx context.Context, ownerID, targetID int64) (bool, error) {
	_, exists, err := s.GetCallBlock(ctx, ownerID, targetID)
	return exists, err
}

// CallBlockEntry is one row of the owner's 呼叫屏蔽列表: the target's render
// identity plus the effective block state.
type CallBlockEntry struct {
	UserID        int64         `json:"userId"`
	Username      string        `json:"username"`
	DisplayName   string        `json:"displayName"`
	AvatarVersion int           `json:"avatarVersion"`
	HasAvatar     bool          `json:"hasAvatar"`
	Kind          CallBlockKind `json:"kind"`
	ExpiresAt     *time.Time    `json:"expiresAt,omitempty"`
}

// GetCallBlock returns the effective block from owner onto target. Expired
// temporary rows are reported as absent. The target must be an existing
// non-deleted user; otherwise ErrNotFound is returned (spec：目标不存在/已删除
// 404；读取模型收归 store，HTTP 层只做哨兵映射)。
func (s *Store) GetCallBlock(ctx context.Context, ownerID, targetID int64) (CallBlock, bool, error) {
	var kind sql.NullString
	var expiresAt sql.NullString
	err := s.db.QueryRowContext(ctx, `
SELECT cb.kind, cb.expires_at
FROM users u
LEFT JOIN call_blocks cb ON cb.owner_user_id = ? AND cb.target_user_id = u.id
WHERE u.id = ? AND u.deleted_at IS NULL`,
		ownerID, targetID).Scan(&kind, &expiresAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return CallBlock{}, false, ErrNotFound
		}
		return CallBlock{}, false, fmt.Errorf("read call block: %w", err)
	}
	block, err := activeCallBlock(kind.String, expiresAt, s.now())
	if err != nil {
		return CallBlock{}, false, err
	}
	if block == nil {
		return CallBlock{}, false, nil
	}
	return *block, true, nil
}

// ListCallBlocks returns the owner's active blocks joined with target user
// identity: temporary blocks first by expiry, then permanent blocks by display
// name.
func (s *Store) ListCallBlocks(ctx context.Context, ownerID int64) ([]CallBlockEntry, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT u.id, u.username, u.display_name, u.avatar_version, u.avatar_bytes IS NOT NULL,
       cb.kind, cb.expires_at
FROM call_blocks cb
JOIN users u ON u.id = cb.target_user_id
WHERE cb.owner_user_id = ? AND u.deleted_at IS NULL
ORDER BY CASE cb.kind WHEN 'temporary' THEN 0 ELSE 1 END,
         COALESCE(cb.expires_at, ''),
         u.display_name COLLATE NOCASE,
         u.id`,
		ownerID)
	if err != nil {
		return nil, fmt.Errorf("list call blocks: %w", err)
	}
	defer rows.Close()

	blocks := make([]CallBlockEntry, 0)
	for rows.Next() {
		var entry CallBlockEntry
		var kind string
		var expiresAt sql.NullString
		var hasAvatar int
		if err := rows.Scan(&entry.UserID, &entry.Username, &entry.DisplayName, &entry.AvatarVersion,
			&hasAvatar, &kind, &expiresAt); err != nil {
			return nil, fmt.Errorf("scan call block: %w", err)
		}
		entry.HasAvatar = hasAvatar != 0
		block, err := activeCallBlock(kind, expiresAt, s.now())
		if err != nil {
			return nil, err
		}
		if block == nil {
			continue
		}
		entry.Kind = block.Kind
		entry.ExpiresAt = block.ExpiresAt
		blocks = append(blocks, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate call blocks: %w", err)
	}
	return blocks, nil
}

// CallBlockCandidate is one search result for adding a block: the target's
// render identity plus its current block state (nil when unblocked).
type CallBlockCandidate struct {
	UserID        int64      `json:"userId"`
	Username      string     `json:"username"`
	DisplayName   string     `json:"displayName"`
	AvatarVersion int        `json:"avatarVersion"`
	HasAvatar     bool       `json:"hasAvatar"`
	Block         *CallBlock `json:"block"`
}

// CallBlockCandidates searches users sharing at least one guild with ownerID
// by username or display-name prefix (case-insensitive). Self, deleted and
// suspended users are excluded (spec：排除自己、已删除与停用用户；平台永久封禁
// 同时置停用标记，随停用条件排除，不再单独过滤). Results are limited to
// 20 and ordered by display name.
func (s *Store) CallBlockCandidates(ctx context.Context, ownerID int64, query string) ([]CallBlockCandidate, error) {
	pattern := escapeLikePattern(query) + "%"
	rows, err := s.db.QueryContext(ctx, `
SELECT u.id, u.username, u.display_name, u.avatar_version, u.avatar_bytes IS NOT NULL,
       cb.kind, cb.expires_at
FROM users u
LEFT JOIN call_blocks cb ON cb.owner_user_id = ? AND cb.target_user_id = u.id
WHERE u.id <> ?
  AND u.deleted_at IS NULL
  AND u.suspended_at IS NULL
  AND (u.username LIKE ? ESCAPE '!' OR u.display_name LIKE ? ESCAPE '!')
  AND EXISTS (
    SELECT 1 FROM guild_members mine
    JOIN guild_members other ON other.guild_id = mine.guild_id
    WHERE mine.user_id = ? AND other.user_id = u.id
  )
ORDER BY u.display_name COLLATE NOCASE, u.id
LIMIT 20`,
		ownerID, ownerID, pattern, pattern, ownerID)
	if err != nil {
		return nil, fmt.Errorf("search call block candidates: %w", err)
	}
	defer rows.Close()

	candidates := make([]CallBlockCandidate, 0)
	for rows.Next() {
		var candidate CallBlockCandidate
		var kind sql.NullString
		var expiresAt sql.NullString
		var hasAvatar int
		if err := rows.Scan(&candidate.UserID, &candidate.Username, &candidate.DisplayName,
			&candidate.AvatarVersion, &hasAvatar, &kind, &expiresAt); err != nil {
			return nil, fmt.Errorf("scan call block candidate: %w", err)
		}
		candidate.HasAvatar = hasAvatar != 0
		if kind.Valid && kind.String != "" {
			block, err := activeCallBlock(kind.String, expiresAt, s.now())
			if err != nil {
				return nil, err
			}
			candidate.Block = block
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate call block candidates: %w", err)
	}
	return candidates, nil
}

func escapeLikePattern(value string) string {
	result := make([]byte, 0, len(value))
	for i := 0; i < len(value); i++ {
		switch value[i] {
		case '!', '%', '_':
			result = append(result, '!', value[i])
		default:
			result = append(result, value[i])
		}
	}
	return string(result)
}

func activeCallBlock(kind string, expiresAt sql.NullString, now time.Time) (*CallBlock, error) {
	if kind == string(CallBlockKindPermanent) {
		return &CallBlock{Kind: CallBlockKindPermanent}, nil
	}
	if kind != string(CallBlockKindTemporary) || !expiresAt.Valid {
		return nil, nil
	}
	expiry, err := parseTime(expiresAt.String)
	if err != nil {
		return nil, fmt.Errorf("parse call block expiry: %w", err)
	}
	if !expiry.After(now) {
		return nil, nil
	}
	return &CallBlock{Kind: CallBlockKindTemporary, ExpiresAt: &expiry}, nil
}

// DeleteCallBlock removes the owner's call block on target. Deleting a
// non-existent block succeeds (idempotent).
func (s *Store) DeleteCallBlock(ctx context.Context, ownerID, targetID int64) error {
	if _, err := s.db.ExecContext(ctx, `
DELETE FROM call_blocks WHERE owner_user_id = ? AND target_user_id = ?`,
		ownerID, targetID); err != nil {
		return fmt.Errorf("delete call block: %w", err)
	}
	return nil
}
