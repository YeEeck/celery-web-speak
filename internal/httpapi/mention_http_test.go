package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yeck/celery-web-speak/internal/store"
)

type mentionPayload struct {
	UserID   int64  `json:"userId"`
	Username string `json:"username"`
}

type mentionMessagePayload struct {
	ID       int64            `json:"id"`
	Content  string           `json:"content"`
	Mentions []mentionPayload `json:"mentions"`
}

func defaultGuildTextChannel(t *testing.T, db *store.Store) (guildID, channelID int64) {
	t.Helper()
	ctx := context.Background()
	guildID, err := db.DefaultGuildID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	channels, err := db.ListGuildChannels(ctx, guildID)
	if err != nil {
		t.Fatal(err)
	}
	for _, channel := range channels {
		if channel.Type == store.ChannelTypeText {
			return guildID, channel.ID
		}
	}
	t.Fatalf("default text channel missing: %+v", channels)
	return 0, 0
}

func createGuildMessage(t *testing.T, server *Server, token string, guildID, channelID int64, body string) *httptest.ResponseRecorder {
	t.Helper()
	path := fmt.Sprintf("/api/guilds/%s/channels/%s/messages", formatID(guildID), formatID(channelID))
	return serveGuildHTTPRequest(server, token, http.MethodPost, path, body)
}

func listGuildMessages(t *testing.T, server *Server, token string, guildID, channelID int64, query string) *httptest.ResponseRecorder {
	t.Helper()
	path := fmt.Sprintf("/api/guilds/%s/channels/%s/messages", formatID(guildID), formatID(channelID))
	if query != "" {
		path += "?" + query
	}
	return serveGuildHTTPRequest(server, token, http.MethodGet, path, "")
}

func decodeCreatedMessage(t *testing.T, recorder *httptest.ResponseRecorder) mentionMessagePayload {
	t.Helper()
	var payload struct {
		Message mentionMessagePayload `json:"message"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode created message: %v %s", err, recorder.Body.String())
	}
	return payload.Message
}

func decodeListedMessages(t *testing.T, recorder *httptest.ResponseRecorder) []mentionMessagePayload {
	t.Helper()
	var payload struct {
		Messages []mentionMessagePayload `json:"messages"`
		HasMore  bool                    `json:"hasMore"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode listed messages: %v %s", err, recorder.Body.String())
	}
	return payload.Messages
}

func TestCreateMessageWithValidMentionReturnsSnapshotOnCreateAndList(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "alice", "爱丽丝")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	guildID, channelID := defaultGuildTextChannel(t, db)
	token := mustSessionToken(t, db, admin.ID)

	body := fmt.Sprintf(`{"content":"hello @ALICE","mentionedUserIds":[%d]}`, target.ID)
	recorder := createGuildMessage(t, server, token, guildID, channelID, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}
	created := decodeCreatedMessage(t, recorder)
	if created.Content != "hello @ALICE" {
		t.Fatalf("created content = %q", created.Content)
	}
	if len(created.Mentions) != 1 {
		t.Fatalf("created mentions = %+v, want one entry", created.Mentions)
	}
	if created.Mentions[0].UserID != target.ID {
		t.Fatalf("created mention userId = %d, want %d", created.Mentions[0].UserID, target.ID)
	}
	if created.Mentions[0].Username != "alice" {
		t.Fatalf("created mention username = %q, want stored spelling alice", created.Mentions[0].Username)
	}

	listRecorder := listGuildMessages(t, server, token, guildID, channelID, "")
	if listRecorder.Code != http.StatusOK {
		t.Fatalf("list = %d %s", listRecorder.Code, listRecorder.Body.String())
	}
	listed := decodeListedMessages(t, listRecorder)
	if len(listed) != 1 {
		t.Fatalf("listed messages = %+v, want one", listed)
	}
	if listed[0].ID != created.ID {
		t.Fatalf("listed id = %d, want %d", listed[0].ID, created.ID)
	}
	if len(listed[0].Mentions) != 1 || listed[0].Mentions[0] != created.Mentions[0] {
		t.Fatalf("listed mentions = %+v, want %+v from create", listed[0].Mentions, created.Mentions)
	}
}

func TestCreateMessageDropsInvalidMentionsSilently(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	guildID, channelID := defaultGuildTextChannel(t, db)
	token := mustSessionToken(t, db, admin.ID)

	alice := newCallPeer(t, db, "alice_keep", "爱丽丝")
	bob := newCallPeer(t, db, "bob_keep", "鲍勃")
	addToDefaultGuild(t, db, admin.ID, alice.Username)
	addToDefaultGuild(t, db, admin.ID, bob.Username)

	outsider := newCallPeer(t, db, "outsider_drop", "外人")
	banned := newCallPeer(t, db, "banned_drop", "封禁")
	addToDefaultGuild(t, db, admin.ID, banned.Username)
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, banned.ID, true, nil); err != nil {
		t.Fatal(err)
	}
	noToken := newCallPeer(t, db, "notoken_drop", "无词")
	addToDefaultGuild(t, db, admin.ID, noToken.Username)

	extras := make([]store.User, 0, 8)
	for i := 0; i < 8; i++ {
		user := newCallPeer(t, db, fmt.Sprintf("extra_keep_%d", i), fmt.Sprintf("额外%d", i))
		addToDefaultGuild(t, db, admin.ID, user.Username)
		extras = append(extras, user)
	}
	eleventh := newCallPeer(t, db, "eleventh_drop", "第十一")
	addToDefaultGuild(t, db, admin.ID, eleventh.Username)

	ids := []int64{
		admin.ID,
		alice.ID,
		alice.ID,
		outsider.ID,
		banned.ID,
		noToken.ID,
		bob.ID,
	}
	for _, extra := range extras {
		ids = append(ids, extra.ID)
	}
	ids = append(ids, eleventh.ID)

	contentParts := []string{"hello @alice_keep @bob_keep"}
	for _, extra := range extras {
		contentParts = append(contentParts, "@"+extra.Username)
	}
	contentParts = append(contentParts, "@eleventh_drop @notoken_dropX")
	content := strings.Join(contentParts, " ")

	idParts := make([]string, len(ids))
	for i, id := range ids {
		idParts[i] = formatID(id)
	}
	body := fmt.Sprintf(`{"content":%q,"mentionedUserIds":[%s]}`, content, strings.Join(idParts, ","))
	recorder := createGuildMessage(t, server, token, guildID, channelID, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}
	created := decodeCreatedMessage(t, recorder)
	if created.Content != content {
		t.Fatalf("created content = %q, want original body", created.Content)
	}
	want := []mentionPayload{{UserID: alice.ID, Username: alice.Username}, {UserID: bob.ID, Username: bob.Username}}
	for _, extra := range extras {
		want = append(want, mentionPayload{UserID: extra.ID, Username: extra.Username})
	}
	if len(created.Mentions) != len(want) {
		t.Fatalf("created mentions = %+v, want %+v", created.Mentions, want)
	}
	for i := range want {
		if created.Mentions[i] != want[i] {
			t.Fatalf("created mentions[%d] = %+v, want %+v", i, created.Mentions[i], want[i])
		}
	}

	listed := decodeListedMessages(t, listGuildMessages(t, server, token, guildID, channelID, ""))
	if len(listed) != 1 || len(listed[0].Mentions) != len(want) {
		t.Fatalf("listed mentions = %+v, want %+v", listed, want)
	}
}

func TestCreateMessageDoesNotBackscanBodyWithoutMentionedUserIds(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	target := newCallPeer(t, db, "alice", "爱丽丝")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	guildID, channelID := defaultGuildTextChannel(t, db)
	token := mustSessionToken(t, db, admin.ID)

	recorder := createGuildMessage(t, server, token, guildID, channelID, `{"content":"hello @alice"}`)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}
	created := decodeCreatedMessage(t, recorder)
	if created.Mentions == nil {
		t.Fatal("created mentions is null, want empty array")
	}
	if len(created.Mentions) != 0 {
		t.Fatalf("created mentions = %+v, want empty", created.Mentions)
	}
	listed := decodeListedMessages(t, listGuildMessages(t, server, token, guildID, channelID, ""))
	if len(listed) != 1 || listed[0].Mentions == nil || len(listed[0].Mentions) != 0 {
		t.Fatalf("listed mentions = %+v, want empty array", listed)
	}
}

func TestCreateMessageMatchesCompleteMentionTokenCaseInsensitively(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	alice := newCallPeer(t, db, "alice", "爱丽丝")
	bob := newCallPeer(t, db, "bob", "鲍勃")
	addToDefaultGuild(t, db, admin.ID, alice.Username)
	addToDefaultGuild(t, db, admin.ID, bob.Username)
	guildID, channelID := defaultGuildTextChannel(t, db)
	token := mustSessionToken(t, db, admin.ID)

	body := fmt.Sprintf(`{"content":"找@ALICE hello@bob","mentionedUserIds":[%d,%d]}`, alice.ID, bob.ID)
	recorder := createGuildMessage(t, server, token, guildID, channelID, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}
	created := decodeCreatedMessage(t, recorder)
	if len(created.Mentions) != 1 {
		t.Fatalf("created mentions = %+v, want only alice", created.Mentions)
	}
	if created.Mentions[0].UserID != alice.ID || created.Mentions[0].Username != "alice" {
		t.Fatalf("created mention = %+v, want stored alice snapshot", created.Mentions[0])
	}
}

func TestListMessagesPaginationIncludesMentionsPerPage(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	alice := newCallPeer(t, db, "page_alice", "分页爱丽丝")
	bob := newCallPeer(t, db, "page_bob", "分页鲍勃")
	addToDefaultGuild(t, db, admin.ID, alice.Username)
	addToDefaultGuild(t, db, admin.ID, bob.Username)
	guildID, channelID := defaultGuildTextChannel(t, db)
	token := mustSessionToken(t, db, admin.ID)

	first := createGuildMessage(t, server, token, guildID, channelID, fmt.Sprintf(`{"content":"hi @page_alice","mentionedUserIds":[%d]}`, alice.ID))
	if first.Code != http.StatusCreated {
		t.Fatalf("create first = %d %s", first.Code, first.Body.String())
	}
	second := createGuildMessage(t, server, token, guildID, channelID, fmt.Sprintf(`{"content":"hi @page_bob","mentionedUserIds":[%d]}`, bob.ID))
	if second.Code != http.StatusCreated {
		t.Fatalf("create second = %d %s", second.Code, second.Body.String())
	}
	firstMessage := decodeCreatedMessage(t, first)
	secondMessage := decodeCreatedMessage(t, second)

	latest := listGuildMessages(t, server, token, guildID, channelID, "limit=1")
	if latest.Code != http.StatusOK {
		t.Fatalf("list latest = %d %s", latest.Code, latest.Body.String())
	}
	latestMessages := decodeListedMessages(t, latest)
	if len(latestMessages) != 1 || latestMessages[0].ID != secondMessage.ID {
		t.Fatalf("latest page = %+v, want second message", latestMessages)
	}
	if len(latestMessages[0].Mentions) != 1 || latestMessages[0].Mentions[0].UserID != bob.ID || latestMessages[0].Mentions[0].Username != bob.Username {
		t.Fatalf("latest mentions = %+v, want bob", latestMessages[0].Mentions)
	}

	earlier := listGuildMessages(t, server, token, guildID, channelID, "before="+formatID(secondMessage.ID)+"&limit=1")
	if earlier.Code != http.StatusOK {
		t.Fatalf("list earlier = %d %s", earlier.Code, earlier.Body.String())
	}
	earlierMessages := decodeListedMessages(t, earlier)
	if len(earlierMessages) != 1 || earlierMessages[0].ID != firstMessage.ID {
		t.Fatalf("earlier page = %+v, want first message", earlierMessages)
	}
	if len(earlierMessages[0].Mentions) != 1 || earlierMessages[0].Mentions[0].UserID != alice.ID || earlierMessages[0].Mentions[0].Username != alice.Username {
		t.Fatalf("earlier mentions = %+v, want alice", earlierMessages[0].Mentions)
	}
}

func TestListedMentionsSurviveLeaveAndGuildBan(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	left := newCallPeer(t, db, "left_user", "离开成员")
	banned := newCallPeer(t, db, "banned_user", "封禁成员")
	addToDefaultGuild(t, db, admin.ID, left.Username)
	addToDefaultGuild(t, db, admin.ID, banned.Username)
	guildID, channelID := defaultGuildTextChannel(t, db)
	token := mustSessionToken(t, db, admin.ID)

	body := fmt.Sprintf(`{"content":"hi @left_user @banned_user","mentionedUserIds":[%d,%d]}`, left.ID, banned.ID)
	recorder := createGuildMessage(t, server, token, guildID, channelID, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}
	created := decodeCreatedMessage(t, recorder)
	if len(created.Mentions) != 2 {
		t.Fatalf("created mentions = %+v, want both members", created.Mentions)
	}

	leave := serveGuildHTTPRequest(server, mustSessionToken(t, db, left.ID), http.MethodPost, "/api/guilds/"+formatID(guildID)+"/leave", "")
	if leave.Code != http.StatusNoContent {
		t.Fatalf("leave = %d %s", leave.Code, leave.Body.String())
	}
	if _, err := db.SetGuildMemberBan(ctx, guildID, admin.ID, banned.ID, true, nil); err != nil {
		t.Fatal(err)
	}

	listed := decodeListedMessages(t, listGuildMessages(t, server, token, guildID, channelID, ""))
	if len(listed) != 1 {
		t.Fatalf("listed messages = %+v, want one", listed)
	}
	want := []mentionPayload{
		{UserID: left.ID, Username: "left_user"},
		{UserID: banned.ID, Username: "banned_user"},
	}
	if len(listed[0].Mentions) != len(want) {
		t.Fatalf("listed mentions = %+v, want %+v", listed[0].Mentions, want)
	}
	for i := range want {
		if listed[0].Mentions[i] != want[i] {
			t.Fatalf("listed mentions[%d] = %+v, want %+v", i, listed[0].Mentions[i], want[i])
		}
	}
}

func TestListedMentionsDropDeletedAccounts(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	kept := newCallPeer(t, db, "kept_user", "保留成员")
	deleted := newCallPeer(t, db, "deleted_user", "删除成员")
	addToDefaultGuild(t, db, admin.ID, kept.Username)
	addToDefaultGuild(t, db, admin.ID, deleted.Username)
	guildID, channelID := defaultGuildTextChannel(t, db)
	token := mustSessionToken(t, db, admin.ID)

	body := fmt.Sprintf(`{"content":"hi @kept_user @deleted_user","mentionedUserIds":[%d,%d]}`, kept.ID, deleted.ID)
	recorder := createGuildMessage(t, server, token, guildID, channelID, body)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}
	if err := db.DeleteUser(ctx, admin.ID, deleted.ID, deleted.Username); err != nil {
		t.Fatal(err)
	}

	listed := decodeListedMessages(t, listGuildMessages(t, server, token, guildID, channelID, ""))
	if len(listed) != 1 {
		t.Fatalf("listed messages = %+v, want one", listed)
	}
	if len(listed[0].Mentions) != 1 || listed[0].Mentions[0].UserID != kept.ID || listed[0].Mentions[0].Username != "kept_user" {
		t.Fatalf("listed mentions = %+v, want only kept_user", listed[0].Mentions)
	}
}

func TestLegacyMessagesReadAsEmptyMentions(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	target := newCallPeer(t, db, "legacy_alice", "历史爱丽丝")
	addToDefaultGuild(t, db, admin.ID, target.Username)
	guildID, channelID := defaultGuildTextChannel(t, db)
	token := mustSessionToken(t, db, admin.ID)

	message, err := db.CreateGuildChannelMessage(ctx, guildID, channelID, admin, "hello @legacy_alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	if message.Mentions == nil || len(message.Mentions) != 0 {
		t.Fatalf("store create mentions = %+v, want empty", message.Mentions)
	}

	listed := decodeListedMessages(t, listGuildMessages(t, server, token, guildID, channelID, ""))
	if len(listed) != 1 || listed[0].ID != message.ID {
		t.Fatalf("listed = %+v, want stored message %d", listed, message.ID)
	}
	if listed[0].Mentions == nil || len(listed[0].Mentions) != 0 {
		t.Fatalf("listed mentions = %+v, want empty array without backscan", listed[0].Mentions)
	}
}
