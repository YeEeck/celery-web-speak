package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const maxChannelsPerType = 50

func (s *Store) ListChannels(ctx context.Context) ([]Channel, error) {
	return s.listChannels(ctx, 0)
}

func (s *Store) ListGuildChannels(ctx context.Context, guildID int64) ([]Channel, error) {
	return s.listChannels(ctx, guildID)
}

func (s *Store) listChannels(ctx context.Context, guildID int64) ([]Channel, error) {
	query := `
SELECT id, guild_id, type, name, COALESCE(audio_bitrate_kbps, 0), COALESCE(background_audio_bitrate_kbps, 0), COALESCE(audio_red_enabled, 0), COALESCE(background_audio_red_enabled, 0), COALESCE(message_retention, 0), created_at, updated_at
FROM channels`
	args := make([]any, 0, 1)
	if guildID > 0 {
		query += " WHERE guild_id = ?"
		args = append(args, guildID)
	}
	query += " ORDER BY id"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	channels := make([]Channel, 0)
	for rows.Next() {
		channel, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		channels = append(channels, channel)
	}
	return channels, rows.Err()
}

func (s *Store) ChannelByID(ctx context.Context, id int64) (Channel, error) {
	channel, err := scanChannel(s.db.QueryRowContext(ctx, `
SELECT id, guild_id, type, name, COALESCE(audio_bitrate_kbps, 0), COALESCE(background_audio_bitrate_kbps, 0), COALESCE(audio_red_enabled, 0), COALESCE(background_audio_red_enabled, 0), COALESCE(message_retention, 0), created_at, updated_at
FROM channels WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	return channel, err
}

func (s *Store) GuildChannelByID(ctx context.Context, guildID, id int64) (Channel, error) {
	channel, err := scanChannel(s.db.QueryRowContext(ctx, `
SELECT id, guild_id, type, name, COALESCE(audio_bitrate_kbps, 0), COALESCE(background_audio_bitrate_kbps, 0), COALESCE(audio_red_enabled, 0), COALESCE(background_audio_red_enabled, 0), COALESCE(message_retention, 0), created_at, updated_at
FROM channels WHERE guild_id = ? AND id = ?`, guildID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	return channel, err
}

func (s *Store) CreateGuildChannel(ctx context.Context, guildID, actorID int64, channelType ChannelType, name string) (Channel, error) {
	name = strings.TrimSpace(name)
	if !validChannelType(channelType) {
		return Channel{}, errors.New("invalid channel type")
	}
	if err := validateChannelName(name); err != nil {
		return Channel{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Channel{}, err
	}
	defer tx.Rollback()
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM channels WHERE guild_id = ? AND type = ?", guildID, channelType).Scan(&count); err != nil {
		return Channel{}, err
	}
	if count >= maxChannelsPerType {
		return Channel{}, ErrChannelLimit
	}
	now := s.now()
	var result sql.Result
	if channelType == ChannelTypeText {
		result, err = tx.ExecContext(ctx, `
INSERT INTO channels (guild_id, type, name, message_retention, created_at, updated_at) VALUES (?, ?, ?, 500, ?, ?)`,
			guildID, channelType, name, formatTime(now), formatTime(now))
	} else {
		result, err = tx.ExecContext(ctx, `
INSERT INTO channels (guild_id, type, name, audio_bitrate_kbps, background_audio_bitrate_kbps, audio_red_enabled, background_audio_red_enabled, created_at, updated_at) VALUES (?, ?, ?, 64, 128, 1, 0, ?, ?)`,
			guildID, channelType, name, formatTime(now), formatTime(now))
	}
	if err != nil {
		if isUniqueError(err) {
			return Channel{}, ErrChannelNameExists
		}
		return Channel{}, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return Channel{}, err
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, nil, "create_channel", fmt.Sprintf("channel_id=%d type=%s name=%q", id, channelType, name)); err != nil {
		return Channel{}, err
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, err
	}
	return s.GuildChannelByID(ctx, guildID, id)
}

func (s *Store) UpdateGuildChannel(ctx context.Context, guildID, actorID, channelID int64, name string, audioBitrateKbps, backgroundAudioBitrateKbps int, audioRedEnabled, backgroundAudioRedEnabled bool, messageRetention int) (Channel, error) {
	name = strings.TrimSpace(name)
	if err := validateChannelName(name); err != nil {
		return Channel{}, err
	}
	channel, err := s.GuildChannelByID(ctx, guildID, channelID)
	if err != nil {
		return Channel{}, err
	}
	if channel.Type == ChannelTypeText {
		if messageRetention < 100 || messageRetention > 5000 {
			return Channel{}, errors.New("message retention must be between 100 and 5000")
		}
	} else {
		if audioBitrateKbps < 32 || audioBitrateKbps > 128 || audioBitrateKbps%8 != 0 {
			return Channel{}, errors.New("audio bitrate must be between 32 and 128 kbps in steps of 8")
		}
		if backgroundAudioBitrateKbps < 64 || backgroundAudioBitrateKbps > 256 || backgroundAudioBitrateKbps%16 != 0 {
			return Channel{}, errors.New("background audio bitrate must be between 64 and 256 kbps in steps of 16")
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Channel{}, err
	}
	defer tx.Rollback()
	if channel.Type == ChannelTypeText {
		_, err = tx.ExecContext(ctx, `UPDATE channels SET name = ?, message_retention = ?, updated_at = ? WHERE id = ?`,
			name, messageRetention, formatTime(s.now()), channelID)
		if err == nil {
			err = trimChannelMessages(ctx, tx, channelID, messageRetention)
		}
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE channels SET name = ?, audio_bitrate_kbps = ?, background_audio_bitrate_kbps = ?, audio_red_enabled = ?, background_audio_red_enabled = ?, updated_at = ? WHERE id = ?`,
			name, audioBitrateKbps, backgroundAudioBitrateKbps, audioRedEnabled, backgroundAudioRedEnabled, formatTime(s.now()), channelID)
	}
	if err != nil {
		if isUniqueError(err) {
			return Channel{}, ErrChannelNameExists
		}
		return Channel{}, err
	}
	details := fmt.Sprintf("channel_id=%d type=%s name=%q bitrate=%d background_bitrate=%d audio_red=%t background_audio_red=%t retention=%d", channelID, channel.Type, name, audioBitrateKbps, backgroundAudioBitrateKbps, audioRedEnabled, backgroundAudioRedEnabled, messageRetention)
	if err := insertGuildAudit(ctx, tx, channel.GuildID, actorID, nil, "update_channel", details); err != nil {
		return Channel{}, err
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, err
	}
	return s.GuildChannelByID(ctx, guildID, channelID)
}

func (s *Store) DeleteGuildChannel(ctx context.Context, guildID, actorID, channelID int64) (Channel, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Channel{}, err
	}
	defer tx.Rollback()
	channel, err := scanChannel(tx.QueryRowContext(ctx, `
SELECT id, guild_id, type, name, COALESCE(audio_bitrate_kbps, 0), COALESCE(background_audio_bitrate_kbps, 0), COALESCE(audio_red_enabled, 0), COALESCE(background_audio_red_enabled, 0), COALESCE(message_retention, 0), created_at, updated_at
FROM channels WHERE guild_id = ? AND id = ?`, guildID, channelID))
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	if err != nil {
		return Channel{}, err
	}
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM channels WHERE guild_id = ? AND type = ?", channel.GuildID, channel.Type).Scan(&count); err != nil {
		return Channel{}, err
	}
	if count <= 1 {
		return Channel{}, ErrLastChannel
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM channels WHERE id = ?", channelID); err != nil {
		return Channel{}, err
	}
	if err := insertGuildAudit(ctx, tx, channel.GuildID, actorID, nil, "delete_channel", fmt.Sprintf("channel_id=%d type=%s name=%q", channel.ID, channel.Type, channel.Name)); err != nil {
		return Channel{}, err
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, err
	}
	return channel, nil
}

func (s *Store) ListChannelReadStates(ctx context.Context, userID int64) ([]ChannelReadState, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT c.id, COALESCE(rs.last_read_message_id, 0), COALESCE(MAX(m.id), 0), COUNT(m.id)
FROM channels c
LEFT JOIN channel_read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
LEFT JOIN messages m ON m.channel_id = c.id AND m.id > COALESCE(rs.last_read_message_id, 0)
WHERE c.type = 'text'
GROUP BY c.id, rs.last_read_message_id
ORDER BY c.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	states := make([]ChannelReadState, 0)
	for rows.Next() {
		var state ChannelReadState
		if err := rows.Scan(&state.ChannelID, &state.LastReadMessageID, &state.LatestMessageID, &state.UnreadCount); err != nil {
			return nil, err
		}
		states = append(states, state)
	}
	return states, rows.Err()
}

func (s *Store) MarkChannelRead(ctx context.Context, userID, channelID int64) (ChannelReadState, error) {
	var channelType ChannelType
	var latestID int64
	err := s.db.QueryRowContext(ctx, `
SELECT c.type, COALESCE(MAX(m.id), 0)
FROM channels c LEFT JOIN messages m ON m.channel_id = c.id
WHERE c.id = ? GROUP BY c.id, c.type`, channelID).Scan(&channelType, &latestID)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelReadState{}, ErrNotFound
	}
	if err != nil {
		return ChannelReadState{}, err
	}
	if channelType != ChannelTypeText {
		return ChannelReadState{}, errors.New("read state requires a text channel")
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO channel_read_states (user_id, channel_id, last_read_message_id, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(user_id, channel_id) DO UPDATE SET
  last_read_message_id = MAX(channel_read_states.last_read_message_id, excluded.last_read_message_id),
  updated_at = excluded.updated_at`, userID, channelID, latestID, formatTime(s.now()))
	if err != nil {
		return ChannelReadState{}, err
	}
	return ChannelReadState{ChannelID: channelID, LastReadMessageID: latestID, LatestMessageID: latestID, UnreadCount: 0}, nil
}

func validChannelType(channelType ChannelType) bool {
	return channelType == ChannelTypeText || channelType == ChannelTypeVoice
}

func validateChannelName(name string) error {
	if length := len([]rune(name)); length < 1 || length > 32 {
		return errors.New("channel name must contain 1 to 32 characters")
	}
	return nil
}

func isUniqueError(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "unique")
}

type channelScanner interface {
	Scan(dest ...any) error
}

func scanChannel(scanner channelScanner) (Channel, error) {
	var channel Channel
	var createdAt, updatedAt string
	if err := scanner.Scan(&channel.ID, &channel.GuildID, &channel.Type, &channel.Name, &channel.AudioBitrateKbps, &channel.BackgroundAudioBitrateKbps, &channel.AudioRedEnabled, &channel.BackgroundAudioRedEnabled, &channel.MessageRetention, &createdAt, &updatedAt); err != nil {
		return Channel{}, err
	}
	channel.CreatedAt, _ = parseTime(createdAt)
	channel.UpdatedAt, _ = parseTime(updatedAt)
	return channel, nil
}
