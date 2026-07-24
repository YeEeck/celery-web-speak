package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) ListGuildChannelMessages(ctx context.Context, guildID, channelID, beforeID int64, limit int) ([]Message, bool, error) {
	channel, err := s.GuildChannelByID(ctx, guildID, channelID)
	if err != nil {
		return nil, false, err
	}
	if channel.Type != ChannelTypeText {
		return nil, false, errors.New("messages require a text channel")
	}
	return s.listChannelMessages(ctx, channelID, beforeID, limit)
}

func (s *Store) listChannelMessages(ctx context.Context, channelID, beforeID int64, limit int) ([]Message, bool, error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	query := `SELECT m.id, m.channel_id, m.user_id,
CASE WHEN u.deleted_at IS NULL THEN u.username ELSE '' END,
CASE WHEN u.deleted_at IS NULL THEN u.display_name ELSE '已删除用户' END,
CASE WHEN u.deleted_at IS NOT NULL THEN 'member'
     WHEN g.owner_user_id = u.id THEN 'owner'
     WHEN gm.role = 'admin' THEN 'admin'
     ELSE 'member' END,
m.content, m.created_at
FROM messages m
JOIN channels c ON c.id = m.channel_id
JOIN guilds g ON g.id = c.guild_id
JOIN users u ON u.id = m.user_id
LEFT JOIN guild_members gm ON gm.guild_id = c.guild_id AND gm.user_id = u.id
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
	reversed := make([]Message, 0, limit+1)
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

func (s *Store) CreateGuildChannelMessage(ctx context.Context, guildID, channelID int64, user User, content string) (Message, error) {
	channel, err := s.GuildChannelByID(ctx, guildID, channelID)
	if err != nil {
		return Message{}, err
	}
	member, err := s.GuildMembership(ctx, guildID, user.ID)
	if err != nil {
		return Message{}, err
	}
	if member.TextMuted {
		return Message{}, errors.New("text muted")
	}
	message, err := s.createChannelMessage(ctx, channel, user, content)
	message.Role = member.Role
	return message, err
}

func (s *Store) createChannelMessage(ctx context.Context, channel Channel, user User, content string) (Message, error) {
	content = strings.TrimSpace(content)
	if content == "" || len([]rune(content)) > 2000 {
		return Message{}, errors.New("message must contain 1 to 2000 characters")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	now := s.now()
	var retention int
	if err := tx.QueryRowContext(ctx, "SELECT message_retention FROM channels WHERE id = ? AND type = 'text'", channel.ID).Scan(&retention); errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	} else if err != nil {
		return Message{}, err
	}
	result, err := tx.ExecContext(ctx, "INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)", channel.ID, user.ID, content, formatTime(now))
	if err != nil {
		return Message{}, err
	}
	if err := trimChannelMessages(ctx, tx, channel.ID, retention); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	id, _ := result.LastInsertId()
	return Message{ID: id, ChannelID: channel.ID, UserID: user.ID, Username: user.Username, DisplayName: user.DisplayName, Role: GuildRoleMember, Content: content, CreatedAt: now}, nil
}

func (s *Store) DeleteGuildChannelMessage(ctx context.Context, guildID, actorID, channelID, messageID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists int
	if err := tx.QueryRowContext(ctx, "SELECT 1 FROM channels WHERE guild_id = ? AND id = ?", guildID, channelID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, "DELETE FROM messages WHERE id = ? AND channel_id = ?", messageID, channelID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, nil, "delete_message", fmt.Sprintf("channel_id=%d message_id=%d", channelID, messageID)); err != nil {
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
