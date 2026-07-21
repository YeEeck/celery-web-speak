package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) ListMessages(ctx context.Context, beforeID int64, limit int) ([]Message, bool, error) {
	channel, err := s.FirstChannel(ctx, ChannelTypeText)
	if err != nil {
		return nil, false, err
	}
	return s.ListChannelMessages(ctx, channel.ID, beforeID, limit)
}

func (s *Store) ListChannelMessages(ctx context.Context, channelID, beforeID int64, limit int) ([]Message, bool, error) {
	channel, err := s.ChannelByID(ctx, channelID)
	if err != nil {
		return nil, false, err
	}
	if channel.Type != ChannelTypeText {
		return nil, false, errors.New("messages require a text channel")
	}
	if limit < 1 || limit > 100 {
		limit = 50
	}
	query := `
	SELECT m.id, m.channel_id, m.user_id,
       CASE WHEN u.deleted_at IS NULL THEN u.username ELSE '' END,
       CASE WHEN u.deleted_at IS NULL THEN u.display_name ELSE '已删除用户' END,
       CASE WHEN u.deleted_at IS NULL THEN u.role ELSE 'member' END,
       m.content, m.created_at
	FROM messages m JOIN users u ON u.id = m.user_id
	WHERE m.channel_id = ?`
	args := []any{channelID}
	if beforeID > 0 {
		query += " AND m.id < ?"
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
		if err := rows.Scan(&message.ID, &message.ChannelID, &message.UserID, &message.Username, &message.DisplayName, &message.Role, &message.Content, &createdAt); err != nil {
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
	channel, err := s.FirstChannel(ctx, ChannelTypeText)
	if err != nil {
		return Message{}, err
	}
	return s.CreateChannelMessage(ctx, channel.ID, user, content)
}

func (s *Store) CreateChannelMessage(ctx context.Context, channelID int64, user User, content string) (Message, error) {
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
	var retention int
	if err := tx.QueryRowContext(ctx, "SELECT message_retention FROM channels WHERE id = ? AND type = 'text'", channelID).Scan(&retention); errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	} else if err != nil {
		return Message{}, err
	}
	result, err := tx.ExecContext(ctx, "INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)", channelID, user.ID, content, formatTime(now))
	if err != nil {
		return Message{}, err
	}
	if err := trimChannelMessages(ctx, tx, channelID, retention); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	id, _ := result.LastInsertId()
	return Message{ID: id, ChannelID: channelID, UserID: user.ID, Username: user.Username, DisplayName: user.DisplayName, Role: user.Role, Content: content, CreatedAt: now}, nil
}

func (s *Store) DeleteMessage(ctx context.Context, actorID, messageID int64) error {
	channel, err := s.FirstChannel(ctx, ChannelTypeText)
	if err != nil {
		return err
	}
	return s.DeleteChannelMessage(ctx, actorID, channel.ID, messageID)
}

func (s *Store) DeleteChannelMessage(ctx context.Context, actorID, channelID, messageID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "DELETE FROM messages WHERE id = ? AND channel_id = ?", messageID, channelID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	if err := insertAudit(ctx, tx, actorID, nil, "delete_message", fmt.Sprintf("channel_id=%d message_id=%d", channelID, messageID)); err != nil {
		return err
	}
	return tx.Commit()
}

func trimChannelMessages(ctx context.Context, tx *sql.Tx, channelID int64, retention int) error {
	_, err := tx.ExecContext(ctx, `
DELETE FROM messages
WHERE channel_id = ?
  AND id NOT IN (SELECT id FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?)`, channelID, channelID, retention)
	return err
}
