package store

import (
	"context"
	"errors"
	"fmt"
)

func (s *Store) Settings(ctx context.Context) (ChannelSettings, error) {
	var settings ChannelSettings
	voice, err := s.FirstChannel(ctx, ChannelTypeVoice)
	if err != nil {
		return settings, err
	}
	text, err := s.FirstChannel(ctx, ChannelTypeText)
	if err != nil {
		return settings, err
	}
	settings.AudioBitrateKbps = voice.AudioBitrateKbps
	settings.MessageRetention = text.MessageRetention
	return settings, nil
}

func (s *Store) UpdateSettings(ctx context.Context, actorID int64, settings ChannelSettings) error {
	if settings.AudioBitrateKbps < 32 || settings.AudioBitrateKbps > 128 || settings.AudioBitrateKbps%8 != 0 {
		return errors.New("audio bitrate must be between 32 and 128 kbps in steps of 8")
	}
	if settings.MessageRetention < 100 || settings.MessageRetention > 5000 {
		return errors.New("message retention must be between 100 and 5000")
	}
	voice, err := s.FirstChannel(ctx, ChannelTypeVoice)
	if err != nil {
		return err
	}
	text, err := s.FirstChannel(ctx, ChannelTypeText)
	if err != nil {
		return err
	}
	if _, err := s.UpdateChannel(ctx, actorID, voice.ID, voice.Name, settings.AudioBitrateKbps, 0); err != nil {
		return fmt.Errorf("update voice settings: %w", err)
	}
	if _, err := s.UpdateChannel(ctx, actorID, text.ID, text.Name, 0, settings.MessageRetention); err != nil {
		return fmt.Errorf("update text settings: %w", err)
	}
	return nil
}
