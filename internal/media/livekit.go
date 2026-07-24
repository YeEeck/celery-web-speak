package media

import (
	"context"
	"errors"
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

const (
	DeafenedAttribute        = "deafened"
	VoiceGenerationAttribute = "voice_generation"
	voiceTokenTTL            = 15 * time.Minute
)

type voiceTarget struct {
	ChannelID  int64
	GuildID    int64
	RoomName   string
	Generation uint64
	ExpiresAt  time.Time
}

type Service struct {
	apiKey      string
	apiSecret   string
	publicURL   string
	room        *lksdk.RoomServiceClient
	keyProvider auth.KeyProvider
	mu          sync.RWMutex
	rooms       map[int64]map[int64]VoiceParticipant
	targets     map[int64]voiceTarget
	revision    uint64
	generation  uint64
	now         func() time.Time
}

type JoinCredentials struct {
	URL       string `json:"url"`
	Token     string `json:"token"`
	RoomName  string `json:"roomName"`
	ChannelID int64  `json:"channelId"`
}

type VoiceParticipant struct {
	UserID     int64  `json:"userId"`
	Identity   string `json:"identity"`
	Name       string `json:"name"`
	JoinedAt   int64  `json:"joinedAt"`
	Generation uint64 `json:"-"`
}

type VoiceRoom struct {
	GuildID      int64              `json:"serverId,omitempty"`
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
		targets:     make(map[int64]voiceTarget),
		now:         time.Now,
	}
}

func Identity(userID int64) string { return "user-" + strconv.FormatInt(userID, 10) }

func RoomName(ids ...int64) string {
	if len(ids) >= 2 {
		return "guild-" + strconv.FormatInt(ids[0], 10) + "-channel-" + strconv.FormatInt(ids[1], 10)
	}
	if len(ids) == 1 {
		return "channel-" + strconv.FormatInt(ids[0], 10)
	}
	return ""
}

func GuildRoomName(guildID, channelID int64) string {
	return RoomName(guildID, channelID)
}

func ParseRoomName(name string) (int64, bool) {
	if _, channelID, ok := ParseGuildRoomName(name); ok {
		return channelID, true
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(name, "channel-"), 10, 64)
	return id, strings.HasPrefix(name, "channel-") && err == nil && id > 0
}

func ParseGuildRoomName(name string) (int64, int64, bool) {
	parts := strings.Split(name, "-")
	if len(parts) != 4 || parts[0] != "guild" || parts[2] != "channel" {
		return 0, 0, false
	}
	guildID, guildErr := strconv.ParseInt(parts[1], 10, 64)
	channelID, channelErr := strconv.ParseInt(parts[3], 10, 64)
	return guildID, channelID, guildErr == nil && channelErr == nil && guildID > 0 && channelID > 0
}

func (s *Service) JoinCredentials(ctx context.Context, user store.User, channelID int64) (JoinCredentials, error) {
	return s.joinCredentials(ctx, user, 0, channelID, string(user.Role), user.VoiceMuted)
}

func (s *Service) JoinGuildCredentials(ctx context.Context, user store.User, member store.GuildMember, channelID int64) (JoinCredentials, error) {
	return s.joinCredentials(ctx, user, member.GuildID, channelID, string(member.Role), member.VoiceMuted)
}

func (s *Service) joinCredentials(ctx context.Context, user store.User, guildID, channelID int64, role string, voiceMuted bool) (JoinCredentials, error) {
	now := s.now()
	roomName := RoomName(channelID)
	if guildID > 0 {
		roomName = GuildRoomName(guildID, channelID)
	}
	s.mu.Lock()
	previous := s.targets[user.ID]
	generation := s.nextGenerationLocked(now)
	s.targets[user.ID] = voiceTarget{ChannelID: channelID, GuildID: guildID, RoomName: roomName, Generation: generation, ExpiresAt: now.Add(voiceTokenTTL)}
	s.revision++
	s.mu.Unlock()
	if previous.ChannelID > 0 && previous.ChannelID != channelID {
		_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: previous.roomName(), Identity: Identity(user.ID)})
	}

	canPublish := !voiceMuted
	canSubscribe := true
	canPublishData := false
	canSubscribeMetrics := true
	grant := &auth.VideoGrant{
		RoomJoin:            true,
		Room:                roomName,
		CanPublish:          &canPublish,
		CanSubscribe:        &canSubscribe,
		CanPublishData:      &canPublishData,
		CanSubscribeMetrics: &canSubscribeMetrics,
	}
	if canPublish {
		grant.SetCanPublishSources(voicePublishSources())
	}
	token, err := auth.NewAccessToken(s.apiKey, s.apiSecret).
		SetIdentity(Identity(user.ID)).
		SetName(user.DisplayName).
		SetAttributes(map[string]string{
			"user_id":                strconv.FormatInt(user.ID, 10),
			"username":               user.Username,
			"role":                   role,
			"guild_id":               strconv.FormatInt(guildID, 10),
			"channel_id":             strconv.FormatInt(channelID, 10),
			VoiceGenerationAttribute: strconv.FormatUint(generation, 10),
		}).
		SetVideoGrant(grant).
		SetValidFor(voiceTokenTTL).
		ToJWT()
	if err != nil {
		s.mu.Lock()
		if current := s.targets[user.ID]; current.Generation == generation {
			if previous.ChannelID > 0 {
				s.targets[user.ID] = previous
			} else {
				delete(s.targets, user.ID)
			}
			s.revision++
		}
		s.mu.Unlock()
		return JoinCredentials{}, fmt.Errorf("create livekit token: %w", err)
	}
	return JoinCredentials{URL: s.publicURL, Token: token, RoomName: roomName, ChannelID: channelID}, nil
}

func (s *Service) SetCanPublish(ctx context.Context, userID int64, canPublish bool) error {
	target := s.currentTarget(userID)
	if target.ChannelID == 0 {
		return nil
	}
	_, err := s.room.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room:       target.roomName(),
		Identity:   Identity(userID),
		Permission: voiceParticipantPermission(canPublish),
	})
	return err
}

func voicePublishSources() []livekit.TrackSource {
	return []livekit.TrackSource{
		livekit.TrackSource_MICROPHONE,
		livekit.TrackSource_SCREEN_SHARE_AUDIO,
	}
}

func voiceParticipantPermission(canPublish bool) *livekit.ParticipantPermission {
	sources := []livekit.TrackSource(nil)
	if canPublish {
		sources = voicePublishSources()
	}
	return &livekit.ParticipantPermission{
		CanSubscribe:        true,
		CanPublish:          canPublish,
		CanPublishData:      false,
		CanPublishSources:   sources,
		CanSubscribeMetrics: true,
	}
}

func (s *Service) UpdateName(ctx context.Context, userID int64, displayName string) error {
	target := s.currentTarget(userID)
	if target.ChannelID == 0 {
		return nil
	}
	_, err := s.room.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room: target.roomName(), Identity: Identity(userID), Name: displayName,
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
	target := s.currentTarget(userID)
	if target.ChannelID != channelID {
		return fmt.Errorf("user is not connected to voice channel %d", channelID)
	}
	value := ""
	if deafened {
		value = "true"
	}
	_, err := s.room.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room: target.roomName(), Identity: Identity(userID), Attributes: map[string]string{DeafenedAttribute: value},
	})
	return err
}

func (s *Service) RemoveParticipant(ctx context.Context, userID int64) error {
	s.mu.Lock()
	channelIDs := make(map[int64]struct{})
	target := s.targets[userID]
	if target.ChannelID > 0 {
		channelIDs[target.ChannelID] = struct{}{}
	}
	for channelID, participants := range s.rooms {
		if _, ok := participants[userID]; ok {
			channelIDs[channelID] = struct{}{}
			delete(participants, userID)
		}
	}
	if target.valid(s.now()) {
		target.ChannelID = 0
		s.targets[userID] = target
	} else {
		delete(s.targets, userID)
	}
	if len(channelIDs) > 0 {
		s.revision++
	}
	s.mu.Unlock()
	var result error
	for channelID := range channelIDs {
		roomName := RoomName(channelID)
		if target.ChannelID == channelID {
			roomName = target.roomName()
		}
		_, err := s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: roomName, Identity: Identity(userID)})
		result = errors.Join(result, err)
	}
	return result
}

func (s *Service) DeleteRoom(ctx context.Context, channelID int64) error {
	s.mu.Lock()
	delete(s.rooms, channelID)
	for userID, target := range s.targets {
		if target.ChannelID == channelID {
			target.ChannelID = 0
			s.targets[userID] = target
		}
	}
	s.revision++
	s.mu.Unlock()
	_, err := s.room.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: RoomName(channelID)})
	return err
}

func (s *Service) Refresh(ctx context.Context) (bool, error) {
	revision, issuedTargets := s.snapshotState()
	now := s.now()
	response, err := s.room.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return false, err
	}
	rooms := make(map[int64]map[int64]VoiceParticipant)
	targets := make(map[int64]voiceTarget)
	for userID, target := range issuedTargets {
		if target.valid(now) {
			targets[userID] = target
		}
	}
	removals := make([]livekit.RoomParticipantIdentity, 0)
	for _, roomInfo := range response.Rooms {
		channelID, ok := ParseRoomName(roomInfo.Name)
		if !ok {
			continue
		}
		participants, err := s.room.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: roomInfo.Name})
		if err != nil {
			return false, err
		}
		for _, info := range participants.Participants {
			participant, ok := voiceParticipant(info)
			if !ok {
				continue
			}
			if target, exists := issuedTargets[participant.UserID]; exists && target.valid(now) && !target.accepts(channelID, participant.Generation) {
				removals = append(removals, livekit.RoomParticipantIdentity{Room: roomInfo.Name, Identity: participant.Identity})
				continue
			}
			previousChannel := participantChannel(rooms, participant.UserID)
			if previousChannel > 0 {
				previous := rooms[previousChannel][participant.UserID]
				if !newerParticipant(participant, previous) {
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
			if participant.Generation > targets[participant.UserID].Generation {
				target := targetFromParticipant(channelID, participant, now)
				target.GuildID, _, _ = ParseGuildRoomName(roomInfo.Name)
				target.RoomName = roomInfo.Name
				targets[participant.UserID] = target
			}
		}
	}
	changed, applied := s.replaceSnapshot(revision, rooms, targets)
	if !applied {
		return false, nil
	}
	for index := range removals {
		_, _ = s.room.RemoveParticipant(ctx, &removals[index])
	}
	return changed, nil
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
		if previous.valid(s.now()) && !previous.accepts(channelID, participant.Generation) {
			s.mu.Unlock()
			_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: RoomName(channelID), Identity: participant.Identity})
			return false
		}
		if s.rooms[channelID] == nil {
			s.rooms[channelID] = make(map[int64]VoiceParticipant)
		}
		if previous.ChannelID > 0 && previous.ChannelID != channelID {
			delete(s.rooms[previous.ChannelID], participant.UserID)
		}
		s.rooms[channelID][participant.UserID] = participant
		if participant.Generation >= previous.Generation {
			target := targetFromParticipant(channelID, participant, s.now())
			target.GuildID, _, _ = ParseGuildRoomName(roomInfo.GetName())
			target.RoomName = roomInfo.GetName()
			s.targets[participant.UserID] = target
		}
		if participant.Generation > s.generation {
			s.generation = participant.Generation
		}
		s.revision++
		s.mu.Unlock()
		if previous.ChannelID > 0 && previous.ChannelID != channelID {
			_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: RoomName(previous.ChannelID), Identity: participant.Identity})
		}
		return true
	case webhook.EventParticipantLeft:
		participant, ok := voiceParticipant(event.GetParticipant())
		if !ok {
			return false
		}
		s.mu.Lock()
		stored, exists := s.rooms[channelID][participant.UserID]
		if !exists || (stored.Generation > 0 && participant.Generation > 0 && stored.Generation != participant.Generation) {
			s.mu.Unlock()
			return false
		}
		delete(s.rooms[channelID], participant.UserID)
		s.revision++
		s.mu.Unlock()
		return true
	case webhook.EventRoomFinished:
		s.mu.Lock()
		delete(s.rooms, channelID)
		s.revision++
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
		rooms = append(rooms, VoiceRoom{GuildID: s.guildForChannelLocked(channelID), ChannelID: channelID, Participants: participants})
	}
	sort.Slice(rooms, func(i, j int) bool { return rooms[i].ChannelID < rooms[j].ChannelID })
	return rooms
}

func (s *Service) guildForChannelLocked(channelID int64) int64 {
	for _, target := range s.targets {
		if target.ChannelID == channelID {
			return target.GuildID
		}
	}
	return 0
}

func (s *Service) currentChannel(userID int64) int64 {
	return s.currentTarget(userID).ChannelID
}

func (s *Service) currentTarget(userID int64) voiceTarget {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for channelID, participants := range s.rooms {
		if _, ok := participants[userID]; ok {
			return voiceTarget{ChannelID: channelID, RoomName: RoomName(channelID)}
		}
	}
	if target := s.targets[userID]; target.ChannelID > 0 {
		return target
	}
	return voiceTarget{}
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
	generation, _ := strconv.ParseUint(info.Attributes[VoiceGenerationAttribute], 10, 64)
	return VoiceParticipant{UserID: userID, Identity: info.Identity, Name: info.Name, JoinedAt: joinedAt, Generation: generation}, true
}

func (s *Service) snapshotState() (uint64, map[int64]voiceTarget) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	targets := make(map[int64]voiceTarget, len(s.targets))
	for userID, target := range s.targets {
		targets[userID] = target
	}
	return s.revision, targets
}

func (s *Service) replaceSnapshot(revision uint64, rooms map[int64]map[int64]VoiceParticipant, targets map[int64]voiceTarget) (bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.revision != revision {
		return false, false
	}
	changed := !voiceRoomMapsEqual(s.rooms, rooms)
	if changed || !targetMapsEqual(s.targets, targets) {
		s.rooms = rooms
		s.targets = targets
		for _, target := range targets {
			if target.Generation > s.generation {
				s.generation = target.Generation
			}
		}
		s.revision++
	}
	return changed, true
}

func voiceRoomMapsEqual(a, b map[int64]map[int64]VoiceParticipant) bool {
	if len(a) != len(b) {
		return false
	}
	for channelID, aParticipants := range a {
		bParticipants, ok := b[channelID]
		if !ok || len(aParticipants) != len(bParticipants) {
			return false
		}
		for userID, participant := range aParticipants {
			if other, ok := bParticipants[userID]; !ok || participant != other {
				return false
			}
		}
	}
	return true
}

func targetMapsEqual(a, b map[int64]voiceTarget) bool {
	if len(a) != len(b) {
		return false
	}
	for userID, target := range a {
		if other, ok := b[userID]; !ok || target != other {
			return false
		}
	}
	return true
}

func (s *Service) nextGenerationLocked(now time.Time) uint64 {
	generation := uint64(now.UnixNano())
	if generation <= s.generation {
		generation = s.generation + 1
	}
	s.generation = generation
	return generation
}

func (target voiceTarget) valid(now time.Time) bool {
	return target.ExpiresAt.After(now)
}

func (target voiceTarget) roomName() string {
	if target.RoomName != "" {
		return target.RoomName
	}
	if target.GuildID > 0 {
		return GuildRoomName(target.GuildID, target.ChannelID)
	}
	return RoomName(target.ChannelID)
}

func (target voiceTarget) accepts(channelID int64, generation uint64) bool {
	return target.ChannelID > 0 && generation >= target.Generation && (generation != target.Generation || channelID == target.ChannelID)
}

func targetFromParticipant(channelID int64, participant VoiceParticipant, now time.Time) voiceTarget {
	expiresAt := now.Add(voiceTokenTTL)
	if participant.Generation > 0 {
		expiresAt = time.Unix(0, int64(participant.Generation)).Add(voiceTokenTTL)
	}
	return voiceTarget{ChannelID: channelID, Generation: participant.Generation, ExpiresAt: expiresAt}
}

func participantChannel(rooms map[int64]map[int64]VoiceParticipant, userID int64) int64 {
	for channelID, participants := range rooms {
		if _, exists := participants[userID]; exists {
			return channelID
		}
	}
	return 0
}

func newerParticipant(candidate, current VoiceParticipant) bool {
	if candidate.Generation != current.Generation {
		return candidate.Generation > current.Generation
	}
	return candidate.JoinedAt > current.JoinedAt || (candidate.JoinedAt == current.JoinedAt && candidate.Identity > current.Identity)
}

func (s *Service) DeleteRoomsExcept(ctx context.Context, valid map[int64]struct{}) (bool, error) {
	s.mu.RLock()
	invalid := make([]int64, 0)
	for channelID := range s.rooms {
		if _, exists := valid[channelID]; !exists {
			invalid = append(invalid, channelID)
		}
	}
	s.mu.RUnlock()
	var result error
	for _, channelID := range invalid {
		result = errors.Join(result, s.DeleteRoom(ctx, channelID))
	}
	return len(invalid) > 0, result
}
