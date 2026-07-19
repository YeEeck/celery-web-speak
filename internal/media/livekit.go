package media

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/yeck/celery-web-speak/internal/store"
)

const RoomName = "main"

type Service struct {
	apiKey    string
	apiSecret string
	publicURL string
	room      *lksdk.RoomServiceClient
}

type JoinCredentials struct {
	URL      string `json:"url"`
	Token    string `json:"token"`
	RoomName string `json:"roomName"`
}

func New(url, publicURL, apiKey, apiSecret string) *Service {
	return &Service{
		apiKey:    apiKey,
		apiSecret: apiSecret,
		publicURL: publicURL,
		room:      lksdk.NewRoomServiceClient(url, apiKey, apiSecret),
	}
}

func Identity(userID int64) string { return "user-" + strconv.FormatInt(userID, 10) }

func (s *Service) JoinCredentials(user store.User) (JoinCredentials, error) {
	canPublish := !user.VoiceMuted
	canSubscribe := true
	canPublishData := false
	canSubscribeMetrics := true
	grant := &auth.VideoGrant{
		RoomJoin:            true,
		Room:                RoomName,
		CanPublish:          &canPublish,
		CanSubscribe:        &canSubscribe,
		CanPublishData:      &canPublishData,
		CanSubscribeMetrics: &canSubscribeMetrics,
	}
	if canPublish {
		grant.CanPublishSources = []string{"microphone"}
	}
	token, err := auth.NewAccessToken(s.apiKey, s.apiSecret).
		SetIdentity(Identity(user.ID)).
		SetName(user.DisplayName).
		SetAttributes(map[string]string{
			"user_id":  strconv.FormatInt(user.ID, 10),
			"username": user.Username,
			"role":     string(user.Role),
		}).
		SetVideoGrant(grant).
		SetValidFor(15 * time.Minute).
		ToJWT()
	if err != nil {
		return JoinCredentials{}, fmt.Errorf("create livekit token: %w", err)
	}
	return JoinCredentials{URL: s.publicURL, Token: token, RoomName: RoomName}, nil
}

func (s *Service) SetCanPublish(ctx context.Context, userID int64, canPublish bool) error {
	sources := []livekit.TrackSource(nil)
	if canPublish {
		sources = []livekit.TrackSource{livekit.TrackSource_MICROPHONE}
	}
	_, err := s.room.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room:     RoomName,
		Identity: Identity(userID),
		Permission: &livekit.ParticipantPermission{
			CanSubscribe:        true,
			CanPublish:          canPublish,
			CanPublishData:      false,
			CanPublishSources:   sources,
			CanSubscribeMetrics: true,
		},
	})
	return err
}

func (s *Service) UpdateName(ctx context.Context, userID int64, displayName string) error {
	_, err := s.room.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room:     RoomName,
		Identity: Identity(userID),
		Name:     displayName,
	})
	return err
}

func (s *Service) RemoveParticipant(ctx context.Context, userID int64) error {
	_, err := s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room:     RoomName,
		Identity: Identity(userID),
	})
	return err
}
