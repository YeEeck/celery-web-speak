package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) ListMessages(ctx context.Context, beforeID int64, limit int) ([]Message, bool, error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	query := `
SELECT m.id, m.user_id, u.username, u.display_name, u.role, m.content, m.created_at
FROM messages m JOIN users u ON u.id = m.user_id`
	args := []any{}
	if beforeID > 0 {
		query += " WHERE m.id < ?"
		args = append(args, beforeID)
	}
	query += " ORDER BY m.id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	var reversed []Message
	for rows.Next() {
		var message Message
		var createdAt string
		if err := rows.Scan(&message.ID, &message.UserID, &message.Username, &message.DisplayName, &message.Role, &message.Content, &createdAt); err != nil {
			return nil, false, err
		}
		message.CreatedAt, _ = parseTime(createdAt)
		reversed = append(reversed, message)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(reversed) > limit
	if hasMore {
		reversed = reversed[:limit]
	}
	messages := make([]Message, len(reversed))
	for i := range reversed {
		messages[len(reversed)-1-i] = reversed[i]
	}
	return messages, hasMore, nil
}

func (s *Store) CreateMessage(ctx context.Context, user User, content string) (Message, error) {
	content = strings.TrimSpace(content)
	if content == "" || len([]rune(content)) > 2000 {
		return Message{}, errors.New("message must contain 1 to 2000 characters")
	}
	if user.TextMuted {
		return Message{}, errors.New("text muted")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	now := s.now()
	result, err := tx.ExecContext(ctx, "INSERT INTO messages (user_id, content, created_at) VALUES (?, ?, ?)", user.ID, content, formatTime(now))
	if err != nil {
		return Message{}, err
	}
	var retention int
	if err := tx.QueryRowContext(ctx, "SELECT message_retention FROM settings WHERE id = 1").Scan(&retention); err != nil {
		return Message{}, err
	}
	if err := trimMessages(ctx, tx, retention); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	id, _ := result.LastInsertId()
	return Message{ID: id, UserID: user.ID, Username: user.Username, DisplayName: user.DisplayName, Role: user.Role, Content: content, CreatedAt: now}, nil
}

func (s *Store) DeleteMessage(ctx context.Context, actorID, messageID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "DELETE FROM messages WHERE id = ?", messageID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	if err := insertAudit(ctx, tx, actorID, nil, "delete_message", fmt.Sprintf("message_id=%d", messageID)); err != nil {
		return err
	}
	return tx.Commit()
}

func trimMessages(ctx context.Context, tx *sql.Tx, retention int) error {
	_, err := tx.ExecContext(ctx, `
DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)`, retention)
	return err
}
