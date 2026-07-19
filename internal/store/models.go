package store

import "time"

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

type ChannelSettings struct {
	AudioBitrateKbps int `json:"audioBitrateKbps"`
	MessageRetention int `json:"messageRetention"`
}

type Message struct {
	ID          int64     `json:"id"`
	UserID      int64     `json:"userId"`
	Username    string    `json:"username"`
	DisplayName string    `json:"displayName"`
	Role        Role      `json:"role"`
	Content     string    `json:"content"`
	CreatedAt   time.Time `json:"createdAt"`
}

type Invite struct {
	ID        int64      `json:"id"`
	MaxUses   int        `json:"maxUses"`
	UseCount  int        `json:"useCount"`
	ExpiresAt time.Time  `json:"expiresAt"`
	RevokedAt *time.Time `json:"revokedAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	CreatedBy int64      `json:"createdBy"`
}

type CreatedInvite struct {
	Invite
	Code string `json:"code"`
}
