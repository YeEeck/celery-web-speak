package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
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
		message.Mentions = []MessageMention{}
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
	if err := s.attachMessageMentions(ctx, messages); err != nil {
		return nil, false, err
	}
	return messages, hasMore, nil
}

func (s *Store) CreateGuildChannelMessage(ctx context.Context, guildID, channelID int64, user User, content string, mentionedUserIDs []int64) (Message, error) {
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
	message, err := s.createChannelMessage(ctx, channel, user, content, mentionedUserIDs)
	message.Role = member.Role
	return message, err
}

func (s *Store) createChannelMessage(ctx context.Context, channel Channel, user User, content string, mentionedUserIDs []int64) (Message, error) {
	content = strings.TrimSpace(content)
	if content == "" || len([]rune(content)) > 2000 {
		return Message{}, errors.New("message must contain 1 to 2000 characters")
	}
	mentions, err := s.validateMessageMentions(ctx, channel.GuildID, user.ID, content, mentionedUserIDs)
	if err != nil {
		return Message{}, err
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
	id, _ := result.LastInsertId()
	for i, mention := range mentions {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO message_mentions (message_id, user_id, username, position)
VALUES (?, ?, ?, ?)`, id, mention.UserID, mention.Username, i); err != nil {
			return Message{}, err
		}
	}
	if err := trimChannelMessages(ctx, tx, channel.ID, retention); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	if mentions == nil {
		mentions = []MessageMention{}
	}
	return Message{ID: id, ChannelID: channel.ID, UserID: user.ID, Username: user.Username, DisplayName: user.DisplayName, Role: GuildRoleMember, Content: content, Mentions: mentions, CreatedAt: now}, nil
}

const maxMessageMentions = 10

func (s *Store) validateMessageMentions(ctx context.Context, guildID, authorID int64, content string, mentionedUserIDs []int64) ([]MessageMention, error) {
	mentions := make([]MessageMention, 0)
	seen := make(map[int64]struct{})
	for _, userID := range mentionedUserIDs {
		if userID == authorID {
			continue
		}
		if _, ok := seen[userID]; ok {
			continue
		}
		seen[userID] = struct{}{}
		active, err := s.GuildMemberActive(ctx, guildID, userID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				continue
			}
			return nil, err
		}
		if !active {
			continue
		}
		target, err := s.UserByID(ctx, userID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				continue
			}
			return nil, err
		}
		if !contentHasMentionToken(content, target.Username) {
			continue
		}
		mentions = append(mentions, MessageMention{UserID: target.ID, Username: target.Username})
		if len(mentions) == maxMessageMentions {
			break
		}
	}
	return mentions, nil
}

func contentHasMentionToken(content, username string) bool {
	if username == "" {
		return false
	}
	needle := "@" + strings.ToLower(username)
	i := 0
	for i < len(content) {
		at := strings.Index(strings.ToLower(content[i:]), needle)
		if at < 0 {
			return false
		}
		at += i
		if at > 0 {
			prev, _ := utf8.DecodeLastRuneInString(content[:at])
			if isUsernameRune(prev) {
				i = at + 1
				continue
			}
		}
		end := at + len(needle)
		if end < len(content) {
			next, _ := utf8.DecodeRuneInString(content[end:])
			if isUsernameRune(next) {
				i = at + 1
				continue
			}
		}
		return true
	}
	return false
}

func isUsernameRune(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-'
}

func (s *Store) attachMessageMentions(ctx context.Context, messages []Message) error {
	if len(messages) == 0 {
		return nil
	}
	ids := make([]any, 0, len(messages))
	index := make(map[int64]int, len(messages))
	for i, message := range messages {
		ids = append(ids, message.ID)
		index[message.ID] = i
		if messages[i].Mentions == nil {
			messages[i].Mentions = []MessageMention{}
		}
	}
	placeholders := strings.Repeat("?,", len(ids))
	placeholders = placeholders[:len(placeholders)-1]
	query := fmt.Sprintf(`
SELECT mm.message_id, mm.user_id, mm.username
FROM message_mentions mm
JOIN users u ON u.id = mm.user_id AND u.deleted_at IS NULL
WHERE mm.message_id IN (%s)
ORDER BY mm.message_id, mm.position`, placeholders)
	rows, err := s.db.QueryContext(ctx, query, ids...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID int64
		var mention MessageMention
		if err := rows.Scan(&messageID, &mention.UserID, &mention.Username); err != nil {
			return err
		}
		i, ok := index[messageID]
		if !ok {
			continue
		}
		messages[i].Mentions = append(messages[i].Mentions, mention)
	}
	return rows.Err()
}

func (s *Store) DeleteGuildChannelMessage(ctx context.Context, guildID, actorID, channelID, messageID int64, actorRole GuildRole) error {
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
	var authorID int64
	if err := tx.QueryRowContext(ctx, "SELECT user_id FROM messages WHERE id = ? AND channel_id = ?", messageID, channelID).Scan(&authorID); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if authorID != actorID && !actorRole.IsAdmin() {
		return ErrMessageDeleteForbidden
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM messages WHERE id = ? AND channel_id = ?", messageID, channelID); err != nil {
		return err
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, nil, "delete_message", fmt.Sprintf("channel_id=%d message_id=%d", channelID, messageID)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ChannelMessageStats(ctx context.Context, guildID, channelID int64) (ChannelMessageStats, error) {
	channel, err := s.GuildChannelByID(ctx, guildID, channelID)
	if err != nil {
		return ChannelMessageStats{}, err
	}
	if channel.Type != ChannelTypeText {
		return ChannelMessageStats{}, ErrNotFound
	}
	var stats ChannelMessageStats
	if err := s.db.QueryRowContext(ctx, `
SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0)
FROM messages WHERE channel_id = ?`, channelID).Scan(&stats.MessageCount, &stats.ContentBytes); err != nil {
		return ChannelMessageStats{}, err
	}
	return stats, nil
}

func (s *Store) ClearGuildChannelMessages(ctx context.Context, guildID, actorID, channelID int64) (int64, error) {
	channel, err := s.GuildChannelByID(ctx, guildID, channelID)
	if err != nil {
		return 0, err
	}
	if channel.Type != ChannelTypeText {
		return 0, ErrNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "DELETE FROM messages WHERE channel_id = ?", channelID)
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, nil, "clear_channel_messages", fmt.Sprintf("channel_id=%d count=%d", channelID, count)); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return count, nil
}

func trimChannelMessages(ctx context.Context, tx *sql.Tx, channelID int64, retention int) error {
	_, err := tx.ExecContext(ctx, `
DELETE FROM messages
WHERE channel_id = ?
  AND id NOT IN (SELECT id FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?)`, channelID, channelID, retention)
	return err
}
