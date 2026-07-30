package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// AddUserOnlineTime accumulates whole seconds of platform presence onto the
// user's running total. It is called by the presence hub when an online
// interval (or a periodic flush of an in-flight interval) settles.
func (s *Store) AddUserOnlineTime(ctx context.Context, userID int64, seconds int64) error {
	if seconds <= 0 {
		return nil
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE users SET online_seconds_total = online_seconds_total + ? WHERE id = ? AND deleted_at IS NULL`, seconds, userID)
	if err != nil {
		return fmt.Errorf("add user online time: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	return nil
}

// UserProfile returns the global, server-agnostic fields surfaced on a
// personal info card: display name, username, bio, platform online time and
// account creation time. Server-scoped permission info is assembled by the
// caller from the in-memory guild member list.
type UserProfile struct {
	ID                 int64     `json:"id"`
	Username           string    `json:"username"`
	DisplayName        string    `json:"displayName"`
	Bio                string    `json:"bio"`
	OnlineSecondsTotal int64     `json:"onlineSecondsTotal"`
	CreatedAt          time.Time `json:"createdAt"`
}

func (s *Store) UserProfile(ctx context.Context, userID int64) (UserProfile, error) {
	var p UserProfile
	var bio sql.NullString
	var createdAt string
	err := s.db.QueryRowContext(ctx, `
SELECT id, username, display_name, bio, online_seconds_total, created_at
FROM users WHERE id = ? AND deleted_at IS NULL`, userID).Scan(
		&p.ID, &p.Username, &p.DisplayName, &bio, &p.OnlineSecondsTotal, &createdAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return UserProfile{}, ErrNotFound
	}
	if err != nil {
		return UserProfile{}, fmt.Errorf("get user profile: %w", err)
	}
	p.Bio = bio.String
	p.CreatedAt, _ = parseTime(createdAt)
	return p, nil
}

// SharedGuild checks whether two users share at least one guild membership. It
// is the authorization predicate for reading another user's profile card.
func (s *Store) SharedGuild(ctx context.Context, userID, otherUserID int64) (bool, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id
WHERE a.user_id = ? AND b.user_id = ?`, userID, otherUserID).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("check shared guild: %w", err)
	}
	return count > 0, nil
}