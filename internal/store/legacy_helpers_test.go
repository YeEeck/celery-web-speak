package store

import "context"

// These helpers keep older storage tests concise while production code only
// exposes server-scoped mutations.
func (s *Store) FirstChannel(ctx context.Context, channelType ChannelType) (Channel, error) {
	guildID, err := s.DefaultGuildID(ctx)
	if err != nil {
		return Channel{}, err
	}
	channels, err := s.ListGuildChannels(ctx, guildID)
	if err != nil {
		return Channel{}, err
	}
	for _, channel := range channels {
		if channel.Type == channelType {
			return channel, nil
		}
	}
	return Channel{}, ErrNotFound
}

func (s *Store) CreateChannel(ctx context.Context, actorID int64, channelType ChannelType, name string) (Channel, error) {
	guildID, err := s.DefaultGuildID(ctx)
	if err != nil {
		return Channel{}, err
	}
	return s.CreateGuildChannel(ctx, guildID, actorID, channelType, name)
}

func (s *Store) UpdateChannel(ctx context.Context, actorID, channelID int64, name string, audioBitrateKbps, backgroundAudioBitrateKbps int, audioRedEnabled, backgroundAudioRedEnabled bool, messageRetention int) (Channel, error) {
	channel, err := s.ChannelByID(ctx, channelID)
	if err != nil {
		return Channel{}, err
	}
	return s.UpdateGuildChannel(ctx, channel.GuildID, actorID, channelID, name, audioBitrateKbps, backgroundAudioBitrateKbps, audioRedEnabled, backgroundAudioRedEnabled, messageRetention)
}

func (s *Store) DeleteChannel(ctx context.Context, actorID, channelID int64) (Channel, error) {
	channel, err := s.ChannelByID(ctx, channelID)
	if err != nil {
		return Channel{}, err
	}
	return s.DeleteGuildChannel(ctx, channel.GuildID, actorID, channelID)
}

func (s *Store) ListMessages(ctx context.Context, beforeID int64, limit int) ([]Message, bool, error) {
	channel, err := s.FirstChannel(ctx, ChannelTypeText)
	if err != nil {
		return nil, false, err
	}
	return s.ListGuildChannelMessages(ctx, channel.GuildID, channel.ID, beforeID, limit)
}

func (s *Store) ListChannelMessages(ctx context.Context, channelID, beforeID int64, limit int) ([]Message, bool, error) {
	channel, err := s.ChannelByID(ctx, channelID)
	if err != nil {
		return nil, false, err
	}
	return s.ListGuildChannelMessages(ctx, channel.GuildID, channelID, beforeID, limit)
}

func (s *Store) CreateMessage(ctx context.Context, user User, content string) (Message, error) {
	channel, err := s.FirstChannel(ctx, ChannelTypeText)
	if err != nil {
		return Message{}, err
	}
	return s.CreateGuildChannelMessage(ctx, channel.GuildID, channel.ID, user, content)
}

func (s *Store) CreateChannelMessage(ctx context.Context, channelID int64, user User, content string) (Message, error) {
	channel, err := s.ChannelByID(ctx, channelID)
	if err != nil {
		return Message{}, err
	}
	return s.CreateGuildChannelMessage(ctx, channel.GuildID, channelID, user, content)
}

func (s *Store) DeleteChannelMessage(ctx context.Context, actorID, channelID, messageID int64) error {
	channel, err := s.ChannelByID(ctx, channelID)
	if err != nil {
		return err
	}
	return s.DeleteGuildChannelMessage(ctx, channel.GuildID, actorID, channelID, messageID)
}
