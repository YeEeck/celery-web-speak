package store

import "time"

type ChannelType string

const (
	ChannelTypeText  ChannelType = "text"
	ChannelTypeVoice ChannelType = "voice"
)

type Role string

const (
	RoleMember       Role = "member"
	RoleChannelAdmin Role = "channel_admin"
	RoleServerAdmin  Role = "server_admin"
)

func (r Role) IsAdmin() bool {
	return r == RoleChannelAdmin || r == RoleServerAdmin
}

type User struct {
	ID                int64      `json:"id"`
	Username          string     `json:"username"`
	DisplayName       string     `json:"displayName"`
	Role              Role       `json:"role"`
	VoiceMuted        bool       `json:"voiceMuted"`
	TextMuted         bool       `json:"textMuted"`
	PermanentlyBanned bool       `json:"permanentlyBanned"`
	TemporaryBanUntil *time.Time `json:"temporaryBanUntil,omitempty"`
	CreatedAt         time.Time  `json:"createdAt"`
}

type Channel struct {
	ID                         int64       `json:"id"`
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
	Role        Role      `json:"role"`
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
