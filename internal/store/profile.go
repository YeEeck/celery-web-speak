package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

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
// All four fields are set jointly by the guild profile read from the
// (user, guild) voice_xp_total and the level formula; VoiceProgress itself is
// nil on unscoped reads.
type VoiceProgress struct {
	XP         int64 `json:"xp"`
	Level      int64 `json:"level"`
	LevelStart int64 `json:"levelStartXp"`
	LevelEnd   int64 `json:"levelEndXp"`
}

// ProfileView is the unscoped personal profile read: the global fields of a
// user, readable by anyone sharing at least one guild membership with the
// target. Platform admins bypass the shared-guild requirement. Returns
// ErrProfileNotInSharedGuild when the requester shares no guild with the
// target and is not a platform admin, ErrNotFound when the target does not
// exist.
func (s *Store) ProfileView(ctx context.Context, requesterID, targetID int64, requesterIsPlatformAdmin bool) (UserProfile, error) {
	if targetID != requesterID {
		shared, err := s.SharedGuild(ctx, requesterID, targetID)
		if err != nil {
			return UserProfile{}, err
		}
		if !shared && !requesterIsPlatformAdmin {
			return UserProfile{}, ErrProfileNotInSharedGuild
		}
	}
	return s.userProfile(ctx, targetID)
}

// GuildProfileView is the guild-scoped personal profile read: the global
// fields plus the target's server voice seconds, voice XP and level progress
// within a guild. Both the requester and the target must be active members of
// that guild; the requester's membership is required so the leaked voice time
// pertains to a server they already belong to. Self reads are allowed as long
// as the requester is an active member. Returns ErrNotGuildMember when the
// requester is not a member of the guild, ErrNotFound when the target is not
// an active member of the guild or does not exist.
func (s *Store) GuildProfileView(ctx context.Context, requesterID, targetID, guildID int64) (UserProfile, error) {
	if _, err := s.GuildMembership(ctx, guildID, requesterID); err != nil {
		if errors.Is(err, ErrNotFound) {
			return UserProfile{}, ErrNotGuildMember
		}
		return UserProfile{}, err
	}
	requesterActive, err := s.GuildMemberActive(ctx, guildID, requesterID)
	if err != nil {
		return UserProfile{}, err
	}
	if !requesterActive {
		return UserProfile{}, ErrNotFound
	}
	if targetID != requesterID {
		targetActive, err := s.GuildMemberActive(ctx, guildID, targetID)
		if err != nil {
			return UserProfile{}, err
		}
		if !targetActive {
			return UserProfile{}, ErrNotFound
		}
	}
	profile, err := s.userProfile(ctx, targetID)
	if err != nil {
		return UserProfile{}, err
	}
	seconds, err := s.GuildMemberVoiceSeconds(ctx, guildID, targetID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return UserProfile{}, err
	}
	xp, err := s.GuildMemberVoiceXP(ctx, guildID, targetID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return UserProfile{}, err
	}
	progress := VoiceProgressAt(xp)
	profile.VoiceSecondsTotal = &seconds
	profile.VoiceXPTotal = &xp
	profile.VoiceProgress = &progress
	return profile, nil
}

func (s *Store) userProfile(ctx context.Context, userID int64) (UserProfile, error) {
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
// is the authorization predicate for the unscoped personal profile read.
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
