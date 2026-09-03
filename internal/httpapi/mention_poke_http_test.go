package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

func registerGuildClient(t *testing.T, server *Server, userID, guildID int64) *client {
	t.Helper()
	c := newClient(store.User{ID: userID})
	server.hub.register(c)
	server.hub.SetClientGuilds(c, []int64{guildID})
	t.Cleanup(func() { server.hub.unregister(c, true) })
	return c
}

func collectClientEvents(t *testing.T, c *client, min int) []event {
	t.Helper()
	events := readClientEvents(t, c, min)
	for {
		select {
		case payload := <-c.send:
			var item event
			if err := json.Unmarshal(payload, &item); err != nil {
				t.Fatalf("decode extra client event: %v", err)
			}
			events = append(events, item)
		case <-time.After(50 * time.Millisecond):
			return events
		}
	}
}

func eventOfType(t *testing.T, events []event, typ string) event {
	t.Helper()
	for _, item := range events {
		if item.Type == typ {
			return item
		}
	}
	t.Fatalf("missing %s event in %+v", typ, eventTypes(events))
	return event{}
}

func eventTypes(events []event) []string {
	types := make([]string, 0, len(events))
	for _, item := range events {
		types = append(types, item.Type)
	}
	return types
}

func countEventsOfType(events []event, typ string) int {
	n := 0
	for _, item := range events {
		if item.Type == typ {
			n++
		}
	}
	return n
}

func pokeDispatchedFlag(t *testing.T, item event) *bool {
	t.Helper()
	payload, err := json.Marshal(item.Data)
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		PokeDispatched *bool `json:"pokeDispatched"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	return body.PokeDispatched
}

func httpMessageHasPokeDispatched(t *testing.T, raw []byte) bool {
	t.Helper()
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("decode envelope: %v %s", err, raw)
	}
	messageRaw, ok := envelope["message"]
	if !ok {
		t.Fatalf("response missing message: %s", raw)
	}
	var message map[string]json.RawMessage
	if err := json.Unmarshal(messageRaw, &message); err != nil {
		t.Fatalf("decode message: %v %s", err, messageRaw)
	}
	_, present := message["pokeDispatched"]
	return present
}

func waitForEventType(t *testing.T, c *client, typ string) event {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		select {
		case payload := <-c.send:
			var item event
			if err := json.Unmarshal(payload, &item); err != nil {
				t.Fatalf("decode client event: %v", err)
			}
			if item.Type == typ {
				return item
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", typ)
			return event{}
		}
	}
}

func TestMentionOnlineMemberDispatchesPokeAndPrivateFlag(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "mention_poke_online", "被点名在线")
	bystander := newCallPeer(t, db, "mention_poke_bystander", "旁观者")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	addToDefaultGuild(t, db, admin.ID, bystander.Username)
	guildID, channelID := defaultGuildTextChannel(t, db)

	authorClient := registerGuildClient(t, server, admin.ID, guildID)
	targetClient := registerGuildClient(t, server, target.ID, guildID)
	bystanderClient := registerGuildClient(t, server, bystander.ID, guildID)

	token := mustSessionToken(t, db, admin.ID)
	body := fmt.Sprintf(`{"content":"hello @mention_poke_online","mentionedUserIds":[%d]}`, target.ID)
	recorder := createGuildMessage(t, server, token, guildID, channelID, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}
	if httpMessageHasPokeDispatched(t, recorder.Body.Bytes()) {
		t.Fatalf("author HTTP create included pokeDispatched: %s", recorder.Body.String())
	}

	targetEvents := collectClientEvents(t, targetClient, 2)
	if countEventsOfType(targetEvents, "poke") != 1 {
		t.Fatalf("target poke events = %v, want one poke", eventTypes(targetEvents))
	}
	if countEventsOfType(targetEvents, "message_created") != 1 {
		t.Fatalf("target message_created events = %v, want one", eventTypes(targetEvents))
	}
	poke := eventOfType(t, targetEvents, "poke")
	if poke.GuildID != 0 {
		t.Fatalf("poke guildId = %d, want omitted/0", poke.GuildID)
	}
	var pokeData struct {
		ActorUserID int64  `json:"actorUserId"`
		DisplayName string `json:"displayName"`
	}
	decodeEventData(t, poke, &pokeData)
	if pokeData.ActorUserID != admin.ID || pokeData.DisplayName != admin.DisplayName {
		t.Fatalf("poke data = %+v, want actor %d %q", pokeData, admin.ID, admin.DisplayName)
	}
	created := eventOfType(t, targetEvents, "message_created")
	if created.GuildID != guildID {
		t.Fatalf("target message_created guildId = %d, want %d", created.GuildID, guildID)
	}
	flag := pokeDispatchedFlag(t, created)
	if flag == nil || !*flag {
		t.Fatalf("target pokeDispatched = %v, want true", flag)
	}

	bystanderEvents := collectClientEvents(t, bystanderClient, 1)
	if countEventsOfType(bystanderEvents, "poke") != 0 {
		t.Fatalf("bystander received poke: %v", eventTypes(bystanderEvents))
	}
	if countEventsOfType(bystanderEvents, "message_created") != 1 {
		t.Fatalf("bystander events = %v, want one message_created", eventTypes(bystanderEvents))
	}
	if flag := pokeDispatchedFlag(t, eventOfType(t, bystanderEvents, "message_created")); flag != nil {
		t.Fatalf("bystander pokeDispatched = %v, want absent", flag)
	}

	authorEvents := collectClientEvents(t, authorClient, 1)
	if countEventsOfType(authorEvents, "poke") != 0 {
		t.Fatalf("author received poke: %v", eventTypes(authorEvents))
	}
	if flag := pokeDispatchedFlag(t, eventOfType(t, authorEvents, "message_created")); flag != nil {
		t.Fatalf("author live pokeDispatched = %v, want absent", flag)
	}

	listed := listGuildMessages(t, server, token, guildID, channelID, "")
	if listed.Code != http.StatusOK {
		t.Fatalf("list = %d %s", listed.Code, listed.Body.String())
	}
	var listEnvelope map[string]json.RawMessage
	if err := json.Unmarshal(listed.Body.Bytes(), &listEnvelope); err != nil {
		t.Fatal(err)
	}
	var messages []map[string]json.RawMessage
	if err := json.Unmarshal(listEnvelope["messages"], &messages); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 {
		t.Fatalf("listed = %d messages, want 1", len(messages))
	}
	if _, ok := messages[0]["pokeDispatched"]; ok {
		t.Fatalf("historical list included pokeDispatched: %s", listed.Body.String())
	}
}

func TestMentionOfflineMemberDoesNotDispatchPoke(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "mention_poke_offline", "被点名离线")
	bystander := newCallPeer(t, db, "mention_poke_offline_bystander", "旁观者")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	addToDefaultGuild(t, db, admin.ID, bystander.Username)
	guildID, channelID := defaultGuildTextChannel(t, db)

	authorClient := registerGuildClient(t, server, admin.ID, guildID)
	bystanderClient := registerGuildClient(t, server, bystander.ID, guildID)

	token := mustSessionToken(t, db, admin.ID)
	body := fmt.Sprintf(`{"content":"hello @mention_poke_offline","mentionedUserIds":[%d]}`, target.ID)
	recorder := createGuildMessage(t, server, token, guildID, channelID, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}

	created := waitForEventType(t, bystanderClient, "message_created")
	if flag := pokeDispatchedFlag(t, created); flag != nil {
		t.Fatalf("bystander pokeDispatched = %v, want absent", flag)
	}
	authorCreated := waitForEventType(t, authorClient, "message_created")
	if flag := pokeDispatchedFlag(t, authorCreated); flag != nil {
		t.Fatalf("author pokeDispatched = %v, want absent", flag)
	}
	assertNoPokeEvent(t, authorClient)
	assertNoPokeEvent(t, bystanderClient)
}

func TestMentionAfterCardPokeSharesPairCooldown(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "mention_poke_cooldown", "冷却目标")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	guildID, channelID := defaultGuildTextChannel(t, db)
	targetClient := registerGuildClient(t, server, target.ID, guildID)

	token := mustSessionToken(t, db, admin.ID)
	pokeRecorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
	if pokeRecorder.Code != http.StatusNoContent {
		t.Fatalf("card poke = %d %s", pokeRecorder.Code, pokeRecorder.Body.String())
	}
	readPokeEvent(t, targetClient)

	body := fmt.Sprintf(`{"content":"hello @mention_poke_cooldown","mentionedUserIds":[%d]}`, target.ID)
	recorder := createGuildMessage(t, server, token, guildID, channelID, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}

	created := waitForEventType(t, targetClient, "message_created")
	if flag := pokeDispatchedFlag(t, created); flag != nil {
		t.Fatalf("cooldown mention pokeDispatched = %v, want absent so text-message would play", flag)
	}
	assertNoPokeEvent(t, targetClient)
}

func TestMentionSelfInRawIdsDoesNotPokeAuthor(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	guildID, channelID := defaultGuildTextChannel(t, db)
	authorClient := registerGuildClient(t, server, admin.ID, guildID)
	token := mustSessionToken(t, db, admin.ID)

	body := fmt.Sprintf(`{"content":"hello @root_admin","mentionedUserIds":[%d]}`, admin.ID)
	recorder := createGuildMessage(t, server, token, guildID, channelID, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}
	created := decodeCreatedMessage(t, recorder)
	if len(created.Mentions) != 0 {
		t.Fatalf("created mentions = %+v, want empty after dropping self", created.Mentions)
	}
	waitForEventType(t, authorClient, "message_created")
	assertNoPokeEvent(t, authorClient)
}

func TestMentionInitiatorCapOnlyPokesFirstFittingTarget(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	guildID, channelID := defaultGuildTextChannel(t, db)
	token := mustSessionToken(t, db, admin.ID)

	for i := 0; i < 7; i++ {
		target := newCallPeer(t, db, fmt.Sprintf("mention_cap_card_%d", i), fmt.Sprintf("卡片目标%d", i+1))
		addToDefaultGuild(t, db, admin.ID, target.Username)
		client := registerGuildClient(t, server, target.ID, guildID)
		recorder := serveGuildHTTPRequest(server, token, http.MethodPost, "/api/pokes", pokeBody(target.ID))
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("card poke %d = %d %s", i+1, recorder.Code, recorder.Body.String())
		}
		readPokeEvent(t, client)
	}

	first := newCallPeer(t, db, "mention_cap_first", "提及第一")
	second := newCallPeer(t, db, "mention_cap_second", "提及第二")
	addToDefaultGuild(t, db, admin.ID, first.Username)
	addToDefaultGuild(t, db, admin.ID, second.Username)
	firstClient := registerGuildClient(t, server, first.ID, guildID)
	secondClient := registerGuildClient(t, server, second.ID, guildID)

	body := fmt.Sprintf(`{"content":"hi @mention_cap_first @mention_cap_second","mentionedUserIds":[%d,%d]}`, first.ID, second.ID)
	recorder := createGuildMessage(t, server, token, guildID, channelID, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}

	firstEvents := collectClientEvents(t, firstClient, 2)
	if countEventsOfType(firstEvents, "poke") != 1 {
		t.Fatalf("first mention events = %v, want one poke", eventTypes(firstEvents))
	}
	firstCreated := eventOfType(t, firstEvents, "message_created")
	if flag := pokeDispatchedFlag(t, firstCreated); flag == nil || !*flag {
		t.Fatalf("first pokeDispatched = %v, want true", flag)
	}

	secondCreated := waitForEventType(t, secondClient, "message_created")
	if flag := pokeDispatchedFlag(t, secondCreated); flag != nil {
		t.Fatalf("second pokeDispatched = %v, want absent after initiator cap", flag)
	}
	assertNoPokeEvent(t, secondClient)
}

func TestTextMuteBlocksMentionPokeBecauseMessageCannotSend(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	author := newCallPeer(t, db, "mention_muted_author", "被禁言作者")
	target := newCallPeer(t, db, "mention_muted_target", "禁言目标")
	addToDefaultGuild(t, db, admin.ID, author.Username)
	addToDefaultGuild(t, db, admin.ID, target.Username)
	guildID, channelID := defaultGuildTextChannel(t, db)
	targetClient := registerGuildClient(t, server, target.ID, guildID)
	adminToken := mustSessionToken(t, db, admin.ID)
	authorToken := mustSessionToken(t, db, author.ID)

	mutePath := fmt.Sprintf("/api/guilds/%s/members/%s/mute", formatID(guildID), formatID(author.ID))
	mute := serveGuildHTTPRequest(server, adminToken, http.MethodPatch, mutePath, `{"voiceMuted":false,"textMuted":true}`)
	if mute.Code != http.StatusOK {
		t.Fatalf("mute author = %d %s", mute.Code, mute.Body.String())
	}
	waitForEventType(t, targetClient, "member_updated")

	body := fmt.Sprintf(`{"content":"hello @mention_muted_target","mentionedUserIds":[%d]}`, target.ID)
	recorder := createGuildMessage(t, server, authorToken, guildID, channelID, body)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("muted create = %d %s", recorder.Code, recorder.Body.String())
	}
	assertNoPokeEvent(t, targetClient)
}
