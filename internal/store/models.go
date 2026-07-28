package store

import "time"

type ChannelType string

const (
	ChannelTypeText  ChannelType = "text"
	ChannelTypeVoice ChannelType = "voice"
)

type Role string

const (
	RoleMember        Role = "member"
	RolePlatformAdmin Role = "platform_admin"
)

type GuildRole string

const (
	GuildRoleOwner  GuildRole = "owner"
	GuildRoleAdmin  GuildRole = "admin"
	GuildRoleMember GuildRole = "member"
)

func (r GuildRole) IsAdmin() bool { return r == GuildRoleOwner || r == GuildRoleAdmin }

type Guild struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	OwnerUserID int64     `json:"ownerUserId"`
	CreatedBy   int64     `json:"createdBy"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type GuildSummary struct {
	Guild
	Joined      bool      `json:"joined"`
	Role        GuildRole `json:"role,omitempty"`
	MemberCount int       `json:"memberCount,omitempty"`
	UnreadCount int       `json:"unreadCount,omitempty"`
}

type GuildOwnershipTransfer struct {
	Guild         Guild
	PreviousOwner GuildMember
	NewOwner      GuildMember
}

type GuildMember struct {
	GuildID           int64      `json:"guildId"`
	UserID            int64      `json:"userId"`
	Username          string     `json:"username"`
	DisplayName       string     `json:"displayName"`
	Role              GuildRole  `json:"role"`
	VoiceMuted        bool       `json:"voiceMuted"`
	TextMuted         bool       `json:"textMuted"`
	PermanentlyBanned bool       `json:"permanentlyBanned"`
	TemporaryBanUntil *time.Time `json:"temporaryBanUntil,omitempty"`
	JoinedAt          time.Time  `json:"joinedAt"`
	AvatarVersion     int        `json:"avatarVersion"`
	HasAvatar         bool       `json:"hasAvatar"`
}

func (m GuildMember) ActiveAt(now time.Time) bool {
	return !m.PermanentlyBanned && (m.TemporaryBanUntil == nil || !m.TemporaryBanUntil.After(now))
}

type User struct {
	ID                int64      `json:"id"`
	Username          string     `json:"username"`
	DisplayName       string     `json:"displayName"`
	Role              Role       `json:"role"`
	VoiceMuted        bool       `json:"voiceMuted,omitempty"`
	TextMuted         bool       `json:"textMuted,omitempty"`
	PermanentlyBanned bool       `json:"permanentlyBanned"`
	TemporaryBanUntil *time.Time `json:"temporaryBanUntil,omitempty"`
	IsPlatformAdmin   bool       `json:"isPlatformAdmin"`
	SuspendedAt       *time.Time `json:"suspendedAt,omitempty"`
	CreatedAt         time.Time  `json:"createdAt"`
	AvatarVersion     int        `json:"avatarVersion"`
	HasAvatar         bool       `json:"hasAvatar"`
}

type Channel struct {
	ID                         int64       `json:"id"`
	GuildID                    int64       `json:"guildId"`
	Type                       ChannelType `json:"type"`
	Name                       string      `json:"name"`
	AudioBitrateKbps           int         `json:"audioBitrateKbps,omitempty"`
	BackgroundAudioBitrateKbps int         `json:"backgroundAudioBitrateKbps,omitempty"`
	AudioRedEnabled            bool        `json:"audioRedEnabled"`
	BackgroundAudioRedEnabled  bool        `json:"backgroundAudioRedEnabled"`
	MessageRetention           int         `json:"messageRetention,omitempty"`
	CreatedAt                  time.Time   `json:"createdAt"`
	UpdatedAt                  time.Time   `json:"updatedAt"`
}

type ChannelReadState struct {
	ChannelID         int64 `json:"channelId"`
	LastReadMessageID int64 `json:"lastReadMessageId"`
	LatestMessageID   int64 `json:"latestMessageId"`
	UnreadCount       int   `json:"unreadCount"`
}

type Message struct {
	ID          int64     `json:"id"`
	ChannelID   int64     `json:"channelId"`
	UserID      int64     `json:"userId"`
	Username    string    `json:"username"`
	DisplayName string    `json:"displayName"`
	Role        GuildRole `json:"role"`
	Content     string    `json:"content"`
	CreatedAt   time.Time `json:"createdAt"`
}

type Invite struct {
	ID        int64      `json:"id"`
	Code      string     `json:"code,omitempty"`
	MaxUses   int        `json:"maxUses"`
	UseCount  int        `json:"useCount"`
	ExpiresAt time.Time  `json:"expiresAt"`
	RevokedAt *time.Time `json:"revokedAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	CreatedBy int64      `json:"createdBy"`
}

type CreatedInvite struct {
	Invite
}

type InviteCursor struct {
	Active   bool
	SortTime time.Time
	ID       int64
}
