package media

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/yeck/celery-web-speak/internal/store"
)

const DeafenedAttribute = "deafened"

type Service struct {
	apiKey      string
	apiSecret   string
	publicURL   string
	room        *lksdk.RoomServiceClient
	keyProvider auth.KeyProvider
	mu          sync.RWMutex
	rooms       map[int64]map[int64]VoiceParticipant
	targets     map[int64]int64
}

type JoinCredentials struct {
	URL       string `json:"url"`
	Token     string `json:"token"`
	RoomName  string `json:"roomName"`
	ChannelID int64  `json:"channelId"`
}

type VoiceParticipant struct {
	UserID   int64  `json:"userId"`
	Identity string `json:"identity"`
	Name     string `json:"name"`
	JoinedAt int64  `json:"joinedAt"`
}

type VoiceRoom struct {
	ChannelID    int64              `json:"channelId"`
	Participants []VoiceParticipant `json:"participants"`
}

func New(url, publicURL, apiKey, apiSecret string) *Service {
	return &Service{
		apiKey:      apiKey,
		apiSecret:   apiSecret,
		publicURL:   publicURL,
		room:        lksdk.NewRoomServiceClient(url, apiKey, apiSecret),
		keyProvider: auth.NewSimpleKeyProvider(apiKey, apiSecret),
		rooms:       make(map[int64]map[int64]VoiceParticipant),
		targets:     make(map[int64]int64),
	}
}

func Identity(userID int64) string { return "user-" + strconv.FormatInt(userID, 10) }

func RoomName(channelID int64) string { return "channel-" + strconv.FormatInt(channelID, 10) }

func ParseRoomName(name string) (int64, bool) {
	id, err := strconv.ParseInt(strings.TrimPrefix(name, "channel-"), 10, 64)
	return id, strings.HasPrefix(name, "channel-") && err == nil && id > 0
}

func (s *Service) JoinCredentials(ctx context.Context, user store.User, channelID int64) (JoinCredentials, error) {
	s.mu.Lock()
	previous := s.targets[user.ID]
	s.targets[user.ID] = channelID
	s.mu.Unlock()
	if previous > 0 && previous != channelID {
		_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: RoomName(previous), Identity: Identity(user.ID)})
	}

	canPublish := !user.VoiceMuted
	canSubscribe := true
	canPublishData := false
	canSubscribeMetrics := true
	grant := &auth.VideoGrant{
		RoomJoin:            true,
		Room:                RoomName(channelID),
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
		s.mu.Lock()
		if previous > 0 {
			s.targets[user.ID] = previous
		} else {
			delete(s.targets, user.ID)
		}
		s.mu.Unlock()
		return JoinCredentials{}, fmt.Errorf("create livekit token: %w", err)
	}
	return JoinCredentials{URL: s.publicURL, Token: token, RoomName: RoomName(channelID), ChannelID: channelID}, nil
}

func (s *Service) SetCanPublish(ctx context.Context, userID int64, canPublish bool) error {
	channelID := s.currentChannel(userID)
	if channelID == 0 {
		return nil
	}
	sources := []livekit.TrackSource(nil)
	if canPublish {
		sources = []livekit.TrackSource{livekit.TrackSource_MICROPHONE}
	}
	_, err := s.room.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room:     RoomName(channelID),
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
	channelID := s.currentChannel(userID)
	if channelID == 0 {
		return nil
	}
	_, err := s.room.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room: RoomName(channelID), Identity: Identity(userID), Name: displayName,
	})
	return err
}

func (s *Service) SetDeafened(ctx context.Context, userID int64, deafened bool) error {
	channelID := s.currentChannel(userID)
	if channelID == 0 {
		return nil
	}
	return s.SetChannelDeafened(ctx, userID, channelID, deafened)
}

func (s *Service) SetChannelDeafened(ctx context.Context, userID, channelID int64, deafened bool) error {
	if s.currentChannel(userID) != channelID {
		return fmt.Errorf("user is not connected to voice channel %d", channelID)
	}
	value := ""
	if deafened {
		value = "true"
	}
	_, err := s.room.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room: RoomName(channelID), Identity: Identity(userID), Attributes: map[string]string{DeafenedAttribute: value},
	})
	return err
}

func (s *Service) RemoveParticipant(ctx context.Context, userID int64) error {
	s.mu.Lock()
	channelID := s.targets[userID]
	if channelID == 0 {
		for id, participants := range s.rooms {
			if _, ok := participants[userID]; ok {
				channelID = id
				break
			}
		}
	}
	delete(s.targets, userID)
	s.mu.Unlock()
	if channelID == 0 {
		return nil
	}
	_, err := s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: RoomName(channelID), Identity: Identity(userID)})
	return err
}

func (s *Service) DeleteRoom(ctx context.Context, channelID int64) error {
	s.mu.Lock()
	delete(s.rooms, channelID)
	for userID, target := range s.targets {
		if target == channelID {
			delete(s.targets, userID)
		}
	}
	s.mu.Unlock()
	_, err := s.room.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: RoomName(channelID)})
	return err
}

func (s *Service) Refresh(ctx context.Context) error {
	response, err := s.room.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return err
	}
	rooms := make(map[int64]map[int64]VoiceParticipant)
	targets := make(map[int64]int64)
	removals := make([]livekit.RoomParticipantIdentity, 0)
	for _, roomInfo := range response.Rooms {
		channelID, ok := ParseRoomName(roomInfo.Name)
		if !ok {
			continue
		}
		participants, err := s.room.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: roomInfo.Name})
		if err != nil {
			return err
		}
		for _, info := range participants.Participants {
			participant, ok := voiceParticipant(info)
			if !ok {
				continue
			}
			previousChannel := targets[participant.UserID]
			if previousChannel > 0 {
				previous := rooms[previousChannel][participant.UserID]
				if previous.JoinedAt >= participant.JoinedAt {
					removals = append(removals, livekit.RoomParticipantIdentity{Room: roomInfo.Name, Identity: participant.Identity})
					continue
				}
				removals = append(removals, livekit.RoomParticipantIdentity{Room: RoomName(previousChannel), Identity: previous.Identity})
				delete(rooms[previousChannel], participant.UserID)
			}
			if rooms[channelID] == nil {
				rooms[channelID] = make(map[int64]VoiceParticipant)
			}
			rooms[channelID][participant.UserID] = participant
			targets[participant.UserID] = channelID
		}
	}
	s.mu.Lock()
	s.rooms = rooms
	s.targets = targets
	s.mu.Unlock()
	for index := range removals {
		_, _ = s.room.RemoveParticipant(ctx, &removals[index])
	}
	return nil
}

func (s *Service) ReceiveWebhook(r *http.Request) (*livekit.WebhookEvent, error) {
	return webhook.ReceiveWebhookEvent(r, s.keyProvider)
}

func (s *Service) ApplyWebhook(ctx context.Context, event *livekit.WebhookEvent) bool {
	roomInfo := event.GetRoom()
	channelID, ok := ParseRoomName(roomInfo.GetName())
	if !ok {
		return false
	}
	switch event.GetEvent() {
	case webhook.EventParticipantJoined:
		participant, ok := voiceParticipant(event.GetParticipant())
		if !ok {
			return false
		}
		s.mu.Lock()
		previous := s.targets[participant.UserID]
		if s.rooms[channelID] == nil {
			s.rooms[channelID] = make(map[int64]VoiceParticipant)
		}
		if previous > 0 && previous != channelID {
			delete(s.rooms[previous], participant.UserID)
		}
		s.rooms[channelID][participant.UserID] = participant
		s.targets[participant.UserID] = channelID
		s.mu.Unlock()
		if previous > 0 && previous != channelID {
			_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: RoomName(previous), Identity: participant.Identity})
		}
		return true
	case webhook.EventParticipantLeft:
		participant, ok := voiceParticipant(event.GetParticipant())
		if !ok {
			return false
		}
		s.mu.Lock()
		delete(s.rooms[channelID], participant.UserID)
		if s.targets[participant.UserID] == channelID {
			delete(s.targets, participant.UserID)
		}
		s.mu.Unlock()
		return true
	case webhook.EventRoomFinished:
		s.mu.Lock()
		for userID := range s.rooms[channelID] {
			if s.targets[userID] == channelID {
				delete(s.targets, userID)
			}
		}
		delete(s.rooms, channelID)
		s.mu.Unlock()
		return true
	default:
		return false
	}
}

func (s *Service) VoiceRooms() []VoiceRoom {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rooms := make([]VoiceRoom, 0, len(s.rooms))
	for channelID, values := range s.rooms {
		participants := make([]VoiceParticipant, 0, len(values))
		for _, participant := range values {
			participants = append(participants, participant)
		}
		sort.Slice(participants, func(i, j int) bool {
			return participants[i].JoinedAt < participants[j].JoinedAt ||
				(participants[i].JoinedAt == participants[j].JoinedAt && participants[i].UserID < participants[j].UserID)
		})
		rooms = append(rooms, VoiceRoom{ChannelID: channelID, Participants: participants})
	}
	sort.Slice(rooms, func(i, j int) bool { return rooms[i].ChannelID < rooms[j].ChannelID })
	return rooms
}

func (s *Service) currentChannel(userID int64) int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if target := s.targets[userID]; target > 0 {
		return target
	}
	for channelID, participants := range s.rooms {
		if _, ok := participants[userID]; ok {
			return channelID
		}
	}
	return 0
}

func voiceParticipant(info *livekit.ParticipantInfo) (VoiceParticipant, bool) {
	if info == nil {
		return VoiceParticipant{}, false
	}
	userID, err := strconv.ParseInt(info.Attributes["user_id"], 10, 64)
	if err != nil || userID < 1 {
		userID, err = strconv.ParseInt(strings.TrimPrefix(info.Identity, "user-"), 10, 64)
	}
	if err != nil || userID < 1 {
		return VoiceParticipant{}, false
	}
	joinedAt := info.JoinedAtMs
	if joinedAt == 0 {
		joinedAt = info.JoinedAt * 1000
	}
	return VoiceParticipant{UserID: userID, Identity: info.Identity, Name: info.Name, JoinedAt: joinedAt}, true
}
