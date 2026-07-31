package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

const MaxGuildMemberVoiceXP int64 = 1_000_000_000

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

// AddGuildVoiceTime accumulates whole seconds of voice participation by a
// user within a specific guild onto the (user, guild) running total, and in
// the same UPDATE credits voice XP at the fixed tick-path rate of 1 XP per 60
// whole seconds (余数丢弃). XP and seconds are independently adjustable
// quantities with different rules — this fold-in implements only the standard
// 1:1/60 accrual for the voice-time tick. Multi-source XP adjustments
// (activity bonuses, retroactive deductions) write voice_xp_total directly by
// other means and never go through this function. It is called by the media
// voice-time accumulator on a periodic snapshot tick.
func (s *Store) AddGuildVoiceTime(ctx context.Context, guildID, userID int64, seconds int64) error {
	if seconds <= 0 {
		return nil
	}
	xp := seconds / 60
	result, err := s.db.ExecContext(ctx, `
UPDATE guild_members
SET voice_seconds_total = voice_seconds_total + ?,
    voice_xp_total = voice_xp_total + ?
WHERE guild_id = ? AND user_id = ?`, seconds, xp, guildID, userID)
	if err != nil {
		return fmt.Errorf("add guild voice time: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	return nil
}

// GuildMemberVoiceSeconds returns the accumulated voice seconds for a user
// within a guild. Returns ErrNotFound if the user is not a member of that
// guild.
func (s *Store) GuildMemberVoiceSeconds(ctx context.Context, guildID, userID int64) (int64, error) {
	var seconds int64
	err := s.db.QueryRowContext(ctx, `
SELECT voice_seconds_total FROM guild_members WHERE guild_id = ? AND user_id = ?`, guildID, userID).Scan(&seconds)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("get guild member voice seconds: %w", err)
	}
	return seconds, nil
}

// GuildMemberVoiceXP returns the accumulated voice XP for a user within a
// guild. Returns ErrNotFound if the user is not a member of that guild.
func (s *Store) GuildMemberVoiceXP(ctx context.Context, guildID, userID int64) (int64, error) {
	var xp int64
	err := s.db.QueryRowContext(ctx, `
SELECT voice_xp_total FROM guild_members WHERE guild_id = ? AND user_id = ?`, guildID, userID).Scan(&xp)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("get guild member voice xp: %w", err)
	}
	return xp, nil
}

// UserProfile returns the global, server-agnostic fields surfaced on a
// personal info card: display name, username, bio, platform online time and
// account creation time. Server-scoped permission info is assembled by the
// caller from the in-memory guild member list.
//
// VoiceSecondsTotal is the server-scoped voice participation time; it is nil
// when the profile read did not carry a guild_id query parameter. The same
// applies to VoiceXPTotal, the server-scoped voice XP total from which level
// and progress are derived.
type UserProfile struct {
	ID                 int64          `json:"id"`
	Username           string         `json:"username"`
	DisplayName        string         `json:"displayName"`
	Bio                string         `json:"bio"`
	OnlineSecondsTotal int64          `json:"onlineSecondsTotal"`
	VoiceSecondsTotal  *int64         `json:"voiceSecondsTotal,omitempty"`
	VoiceXPTotal       *int64         `json:"voiceXpTotal,omitempty"`
	VoiceProgress      *VoiceProgress `json:"voiceProgress,omitempty"`
	CreatedAt          time.Time      `json:"createdAt"`
}

// VoiceProgress is the server-scoped voice level snapshot surfaced on a
// personal info card when the profile read carried a guild_id query parameter.
// All four fields are set jointly by the HTTP handler from the (user, guild)
// voice_xp_total and the level formula; VoiceProgress itself is nil on
// unscoped reads.
type VoiceProgress struct {
	XP         int64 `json:"xp"`
	Level      int64 `json:"level"`
	LevelStart int64 `json:"levelStartXp"`
	LevelEnd   int64 `json:"levelEndXp"`
}

// GuildMemberVoiceXPChange is the committed before/after snapshot returned
// by an administrative absolute XP update.
type GuildMemberVoiceXPChange struct {
	UserID   int64
	Username string
	BeforeXP int64
	AfterXP  int64
}

// SetGuildMemberVoiceXP replaces a member's server voice XP and records the
// change in the same transaction. It rechecks the actor and target inside the
// transaction so a role or membership change cannot bypass authorization.
func (s *Store) SetGuildMemberVoiceXP(ctx context.Context, guildID, actorID, userID, xp int64) (GuildMemberVoiceXPChange, error) {
	if xp < 0 || xp > MaxGuildMemberVoiceXP {
		return GuildMemberVoiceXPChange{}, ErrInvalidGuildMemberVoiceXP
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GuildMemberVoiceXPChange{}, err
	}
	defer tx.Rollback()

	var actorRole string
	var actorPlatformAdmin int
	var actorUserPermanentlyBanned int
	var actorSuspendedAt sql.NullString
	var actorGuildPermanentlyBanned int
	var actorTemporaryBanUntil sql.NullString
	if err := tx.QueryRowContext(ctx, `
SELECT CASE WHEN g.owner_user_id = gm.user_id THEN 'owner' ELSE gm.role END,
       u.is_platform_admin, u.permanently_banned, u.suspended_at,
       gm.permanently_banned, gm.temporary_ban_until
FROM guild_members gm
JOIN guilds g ON g.id = gm.guild_id
JOIN users u ON u.id = gm.user_id AND u.deleted_at IS NULL
WHERE gm.guild_id = ? AND gm.user_id = ?`, guildID, actorID).Scan(
		&actorRole, &actorPlatformAdmin, &actorUserPermanentlyBanned, &actorSuspendedAt,
		&actorGuildPermanentlyBanned, &actorTemporaryBanUntil,
	); errors.Is(err, sql.ErrNoRows) {
		return GuildMemberVoiceXPChange{}, ErrGuildMemberVoiceXPForbidden
	} else if err != nil {
		return GuildMemberVoiceXPChange{}, fmt.Errorf("read guild member voice xp actor: %w", err)
	}
	actorTemporarilyBanned, err := temporaryBanActive(s, actorTemporaryBanUntil)
	if err != nil {
		return GuildMemberVoiceXPChange{}, fmt.Errorf("parse actor temporary ban: %w", err)
	}
	if actorUserPermanentlyBanned != 0 || actorSuspendedAt.Valid || actorGuildPermanentlyBanned != 0 || actorTemporarilyBanned {
		return GuildMemberVoiceXPChange{}, ErrGuildMemberVoiceXPForbidden
	}

	var username string
	var before int64
	var targetRole string
	var targetGuildPermanentlyBanned int
	var temporaryBanUntil sql.NullString
	var targetUserPermanentlyBanned int
	var targetSuspendedAt sql.NullString
	if err := tx.QueryRowContext(ctx, `
SELECT u.username, gm.voice_xp_total,
       CASE WHEN g.owner_user_id = gm.user_id THEN 'owner' ELSE gm.role END,
       gm.permanently_banned, gm.temporary_ban_until,
       u.permanently_banned, u.suspended_at
FROM guild_members gm
JOIN guilds g ON g.id = gm.guild_id
JOIN users u ON u.id = gm.user_id AND u.deleted_at IS NULL
WHERE gm.guild_id = ? AND gm.user_id = ?`, guildID, userID).Scan(
		&username, &before, &targetRole, &targetGuildPermanentlyBanned, &temporaryBanUntil,
		&targetUserPermanentlyBanned, &targetSuspendedAt,
	); errors.Is(err, sql.ErrNoRows) {
		return GuildMemberVoiceXPChange{}, ErrNotFound
	} else if err != nil {
		return GuildMemberVoiceXPChange{}, fmt.Errorf("read guild member voice xp target: %w", err)
	}
	if targetUserPermanentlyBanned != 0 || targetSuspendedAt.Valid || targetGuildPermanentlyBanned != 0 {
		return GuildMemberVoiceXPChange{}, ErrNotFound
	}
	targetTemporarilyBanned, err := temporaryBanActive(s, temporaryBanUntil)
	if err != nil {
		return GuildMemberVoiceXPChange{}, fmt.Errorf("parse target temporary ban: %w", err)
	}
	if targetTemporarilyBanned {
		return GuildMemberVoiceXPChange{}, ErrNotFound
	}

	canManage := false
	switch targetRole {
	case string(GuildRoleOwner):
		canManage = actorRole == string(GuildRoleOwner) && actorID == userID
	case string(GuildRoleAdmin):
		canManage = actorRole == string(GuildRoleOwner) || actorPlatformAdmin != 0
	default:
		canManage = actorRole == string(GuildRoleOwner) || actorRole == string(GuildRoleAdmin) || actorPlatformAdmin != 0
	}
	if !canManage {
		return GuildMemberVoiceXPChange{}, ErrGuildMemberVoiceXPForbidden
	}

	if _, err := tx.ExecContext(ctx, `
UPDATE guild_members SET voice_xp_total = ?, updated_at = ?
WHERE guild_id = ? AND user_id = ?`, xp, formatTime(s.now()), guildID, userID); err != nil {
		return GuildMemberVoiceXPChange{}, fmt.Errorf("set guild member voice xp: %w", err)
	}
	if err := insertGuildAudit(ctx, tx, guildID, actorID, &userID, "set_guild_member_voice_xp", fmt.Sprintf("before_xp=%d after_xp=%d", before, xp)); err != nil {
		return GuildMemberVoiceXPChange{}, err
	}
	if err := tx.Commit(); err != nil {
		return GuildMemberVoiceXPChange{}, err
	}
	return GuildMemberVoiceXPChange{UserID: userID, Username: username, BeforeXP: before, AfterXP: xp}, nil
}

func temporaryBanActive(s *Store, value sql.NullString) (bool, error) {
	if !value.Valid {
		return false, nil
	}
	until, err := parseTime(value.String)
	if err != nil {
		return false, err
	}
	return until.After(s.now()), nil
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
