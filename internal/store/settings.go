package store

import (
	"context"
	"errors"
	"fmt"
)

func (s *Store) Settings(ctx context.Context) (ChannelSettings, error) {
	var settings ChannelSettings
	err := s.db.QueryRowContext(ctx, `
SELECT audio_bitrate_kbps, message_retention FROM settings WHERE id = 1`).Scan(
		&settings.AudioBitrateKbps, &settings.MessageRetention,
	)
	return settings, err
}

func (s *Store) UpdateSettings(ctx context.Context, actorID int64, settings ChannelSettings) error {
	if settings.AudioBitrateKbps < 32 || settings.AudioBitrateKbps > 128 || settings.AudioBitrateKbps%8 != 0 {
		return errors.New("audio bitrate must be between 32 and 128 kbps in steps of 8")
	}
	if settings.MessageRetention < 100 || settings.MessageRetention > 5000 {
		return errors.New("message retention must be between 100 and 5000")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
UPDATE settings SET audio_bitrate_kbps = ?, message_retention = ?, updated_at = ? WHERE id = 1`,
		settings.AudioBitrateKbps, settings.MessageRetention, formatTime(s.now())); err != nil {
		return fmt.Errorf("update settings: %w", err)
	}
	if err := trimMessages(ctx, tx, settings.MessageRetention); err != nil {
		return err
	}
	details := fmt.Sprintf("bitrate=%d retention=%d", settings.AudioBitrateKbps, settings.MessageRetention)
	if err := insertAudit(ctx, tx, actorID, nil, "update_settings", details); err != nil {
		return err
	}
	return tx.Commit()
}
