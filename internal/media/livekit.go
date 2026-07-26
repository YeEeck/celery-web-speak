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

func GuildRoomName(guildID, channelID int64) string {
	return "guild-" + strconv.FormatInt(guildID, 10) + "-channel-" + strconv.FormatInt(channelID, 10)
}

func parseLegacyRoomName(name string) (int64, bool) {
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

func (s *Service) JoinGuildCredentials(ctx context.Context, user store.User, member store.GuildMember, channelID int64, deafened bool) (JoinCredentials, error) {
	return s.joinCredentials(ctx, user, member.GuildID, channelID, string(member.Role), member.VoiceMuted, deafened)
}

func (s *Service) joinCredentials(ctx context.Context, user store.User, guildID, channelID int64, role string, voiceMuted, deafened bool) (JoinCredentials, error) {
	now := s.now()
	roomName := GuildRoomName(guildID, channelID)
	s.mu.Lock()
	previous := s.targets[user.ID]
	generation := s.nextGenerationLocked(now)
	s.targets[user.ID] = voiceTarget{ChannelID: channelID, GuildID: guildID, RoomName: roomName, Generation: generation, ExpiresAt: now.Add(voiceTokenTTL)}
	s.revision++
	s.mu.Unlock()
	if previous.ChannelID > 0 && previous.roomName() != roomName {
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
	attributes := map[string]string{
		"user_id":                strconv.FormatInt(user.ID, 10),
		"username":               user.Username,
		"role":                   role,
		"guild_id":               strconv.FormatInt(guildID, 10),
		"channel_id":             strconv.FormatInt(channelID, 10),
		VoiceGenerationAttribute: strconv.FormatUint(generation, 10),
	}
	if deafened {
		attributes[DeafenedAttribute] = "true"
	}
	token, err := auth.NewAccessToken(s.apiKey, s.apiSecret).
		SetIdentity(Identity(user.ID)).
		SetName(user.DisplayName).
		SetAttributes(attributes).
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

func (s *Service) SetGuildCanPublish(ctx context.Context, userID, guildID int64, canPublish bool) error {
	target := s.currentTarget(userID)
	if target.ChannelID == 0 || target.GuildID != guildID {
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
	roomNames := make(map[string]struct{})
	target := s.targets[userID]
	if target.ChannelID > 0 {
		roomNames[target.roomName()] = struct{}{}
	}
	for channelID, participants := range s.rooms {
		if _, ok := participants[userID]; ok {
			if target.ChannelID == channelID {
				roomNames[target.roomName()] = struct{}{}
			}
			delete(participants, userID)
		}
	}
	if target.valid(s.now()) {
		target.ChannelID = 0
		s.targets[userID] = target
	} else {
		delete(s.targets, userID)
	}
	if len(roomNames) > 0 {
		s.revision++
	}
	s.mu.Unlock()
	var result error
	for roomName := range roomNames {
		_, err := s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: roomName, Identity: Identity(userID)})
		result = errors.Join(result, err)
	}
	return result
}

// RemoveParticipantFromGuild revokes a user's current voice connection only
// when that connection belongs to the specified server. A connection in a
// different server must remain active.
func (s *Service) RemoveParticipantFromGuild(ctx context.Context, userID, guildID int64) error {
	target := s.currentTarget(userID)
	if target.ChannelID == 0 || target.GuildID != guildID {
		return nil
	}
	return s.RemoveParticipant(ctx, userID)
}

// RemoveGuildParticipants revokes all current voice targets in a server.
func (s *Service) RemoveGuildParticipants(ctx context.Context, guildID int64) error {
	s.mu.RLock()
	userIDs := make([]int64, 0)
	for userID, target := range s.targets {
		if target.GuildID == guildID && target.ChannelID > 0 {
			userIDs = append(userIDs, userID)
		}
	}
	s.mu.RUnlock()
	var result error
	for _, userID := range userIDs {
		result = errors.Join(result, s.RemoveParticipantFromGuild(ctx, userID, guildID))
	}
	return result
}

func (s *Service) DeleteGuildRoom(ctx context.Context, guildID, channelID int64) error {
	s.mu.Lock()
	delete(s.rooms, channelID)
	for userID, target := range s.targets {
		if target.GuildID == guildID && target.ChannelID == channelID {
			target.ChannelID = 0
			s.targets[userID] = target
		}
	}
	s.revision++
	s.mu.Unlock()
	_, err := s.room.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: GuildRoomName(guildID, channelID)})
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
		guildID, channelID, ok := ParseGuildRoomName(roomInfo.Name)
		if !ok {
			if _, legacy := parseLegacyRoomName(roomInfo.Name); legacy {
				participants, listErr := s.room.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: roomInfo.Name})
				if listErr != nil {
					return false, listErr
				}
				for _, info := range participants.Participants {
					removals = append(removals, livekit.RoomParticipantIdentity{Room: roomInfo.Name, Identity: info.Identity})
				}
			}
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
			if participant.Generation == 0 {
				removals = append(removals, livekit.RoomParticipantIdentity{Room: roomInfo.Name, Identity: participant.Identity})
				continue
			}
			if target, exists := issuedTargets[participant.UserID]; exists && target.valid(now) && !target.accepts(roomInfo.Name, channelID, participant.Generation) {
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
				previousTarget := targets[participant.UserID]
				removals = append(removals, livekit.RoomParticipantIdentity{Room: previousTarget.roomName(), Identity: previous.Identity})
				delete(rooms[previousChannel], participant.UserID)
			}
			if rooms[channelID] == nil {
				rooms[channelID] = make(map[int64]VoiceParticipant)
			}
			rooms[channelID][participant.UserID] = participant
			if participant.Generation > targets[participant.UserID].Generation {
				target := targetFromParticipant(channelID, participant, now)
				target.GuildID = guildID
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
	roomName := roomInfo.GetName()
	guildID, channelID, ok := ParseGuildRoomName(roomName)
	if !ok {
		if _, legacy := parseLegacyRoomName(roomName); legacy && event.GetEvent() == webhook.EventParticipantJoined {
			if participant := event.GetParticipant(); participant != nil {
				_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: roomName, Identity: participant.Identity})
			}
		}
		return false
	}
	switch event.GetEvent() {
	case webhook.EventParticipantJoined:
		participant, ok := voiceParticipant(event.GetParticipant())
		if !ok {
			return false
		}
		if participant.Generation == 0 {
			_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: roomName, Identity: participant.Identity})
			return false
		}
		s.mu.Lock()
		previous := s.targets[participant.UserID]
		if previous.valid(s.now()) && !previous.accepts(roomName, channelID, participant.Generation) {
			s.mu.Unlock()
			_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: roomName, Identity: participant.Identity})
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
			target.GuildID = guildID
			target.RoomName = roomName
			s.targets[participant.UserID] = target
		}
		if participant.Generation > s.generation {
			s.generation = participant.Generation
		}
		s.revision++
		s.mu.Unlock()
		if previous.ChannelID > 0 && previous.roomName() != roomName {
			_, _ = s.room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: previous.roomName(), Identity: participant.Identity})
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

func (s *Service) currentTarget(userID int64) voiceTarget {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if target := s.targets[userID]; target.ChannelID > 0 {
		return target
	}
	for channelID, participants := range s.rooms {
		if _, ok := participants[userID]; ok {
			guildID := s.guildForChannelLocked(channelID)
			if guildID > 0 {
				return voiceTarget{ChannelID: channelID, GuildID: guildID, RoomName: GuildRoomName(guildID, channelID)}
			}
		}
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
	return ""
}

func (target voiceTarget) accepts(roomName string, channelID int64, generation uint64) bool {
	return target.ChannelID > 0 && generation >= target.Generation &&
		(generation != target.Generation || (channelID == target.ChannelID && roomName == target.roomName()))
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
	invalid := make([]voiceTarget, 0)
	for channelID := range s.rooms {
		if _, exists := valid[channelID]; !exists {
			for _, target := range s.targets {
				if target.ChannelID == channelID {
					invalid = append(invalid, target)
					break
				}
			}
		}
	}
	s.mu.RUnlock()
	var result error
	for _, target := range invalid {
		result = errors.Join(result, s.DeleteGuildRoom(ctx, target.GuildID, target.ChannelID))
	}
	return len(invalid) > 0, result
}
