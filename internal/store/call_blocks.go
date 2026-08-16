package store

import (
	"context"
	"database/sql"
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

// SetCallBlock upserts the owner's call block on target. Setting a temporary
// block starts a fresh 24h window; setting a permanent block clears the
// expiry.
func (s *Store) SetCallBlock(ctx context.Context, ownerID, targetID int64, kind CallBlockKind) (CallBlock, error) {
	if kind != CallBlockKindTemporary && kind != CallBlockKindPermanent {
		return CallBlock{}, fmt.Errorf("invalid call block kind %q", kind)
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
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO call_blocks (owner_user_id, target_user_id, kind, expires_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(owner_user_id, target_user_id) DO UPDATE SET
  kind = excluded.kind,
  expires_at = excluded.expires_at,
  updated_at = excluded.updated_at`,
		ownerID, targetID, string(kind), expiresValue, nowValue, nowValue); err != nil {
		return CallBlock{}, fmt.Errorf("set call block: %w", err)
	}
	return CallBlock{Kind: kind, ExpiresAt: expiresAt}, nil
}

// CallBlockActive reports whether an unexpired block from owner onto target
// exists. Expired temporary rows are treated as absent.
func (s *Store) CallBlockActive(ctx context.Context, ownerID, targetID int64) (bool, error) {
	_, exists, err := s.CallBlock(ctx, ownerID, targetID)
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

// CallBlock returns the effective block from owner onto target. Expired
// temporary rows are reported as absent.
func (s *Store) CallBlock(ctx context.Context, ownerID, targetID int64) (CallBlock, bool, error) {
	var kind string
	var expiresAt sql.NullString
	err := s.db.QueryRowContext(ctx, `
SELECT kind, expires_at FROM call_blocks
WHERE owner_user_id = ? AND target_user_id = ?`,
		ownerID, targetID).Scan(&kind, &expiresAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return CallBlock{}, false, nil
		}
		return CallBlock{}, false, fmt.Errorf("read call block: %w", err)
	}
	block, err := activeCallBlock(kind, expiresAt, s.now())
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
