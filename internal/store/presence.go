package store

import (
	"context"
	"fmt"
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