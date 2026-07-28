package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

// buildMultipartFile builds a multipart/form-data request body with a single
// "file" field containing the supplied bytes and content type, returning the
// body and the generated boundary.
func buildMultipartFile(fieldName string, content []byte, contentType string) (body string, boundary string) {
	var buf bytes.Buffer
	boundary = "----test-boundary-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	buf.WriteString("--" + boundary + "\r\n")
	buf.WriteString("Content-Disposition: form-data; name=\"" + fieldName + "\"; filename=\"upload\"\r\n")
	buf.WriteString("Content-Type: " + contentType + "\r\n\r\n")
	buf.Write(content)
	buf.WriteString("\r\n--" + boundary + "--\r\n")
	return buf.String(), boundary
}

// validSquarePNG builds a minimal valid square PNG of side `dim` that passes
// server-side validation (≤1024×1024, 1:1).
func validSquarePNG(t *testing.T, dim int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, dim, dim))
	for y := 0; y < dim; y++ {
		for x := 0; x < dim; x++ {
			img.SetRGBA(x, y, color.RGBA{R: uint8(x * 255 / dim), G: uint8(y * 255 / dim), B: 64, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func serveGuildIconUpload(server *Server, token, path string, content []byte) *httptest.ResponseRecorder {
	body, boundary := buildMultipartFile("file", content, "image/png")
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
	req.AddCookie(&http.Cookie{Name: "test_session", Value: token})
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	return rec
}

func serveGuildHTTPGet(server *Server, token, path string) *httptest.ResponseRecorder {
	return serveGuildHTTPRequest(server, token, http.MethodGet, path, "")
}

func TestGuildIconUploadRequiresGuildAdmin(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()

	owner, err := db.CreateUser(ctx, "icon_owner", "图标所有者", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	guild, err := db.CreateGuild(ctx, admin.ID, "图标服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}

	member, err := db.CreateUser(ctx, "icon_member", "普通成员", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddGuildMember(ctx, guild.ID, admin.ID, member.Username); err != nil {
		t.Fatal(err)
	}
	memberToken, _, err := db.CreateSession(ctx, member.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	ownerToken, _, err := db.CreateSession(ctx, owner.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	pngBytes := validSquarePNG(t, 32)

	rec := serveGuildIconUpload(server, memberToken, "/api/guilds/"+formatID(guild.ID)+"/icon", pngBytes)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("member upload = %d %s, want 403", rec.Code, rec.Body.String())
	}

	rec = serveGuildIconUpload(server, ownerToken, "/api/guilds/"+formatID(guild.ID)+"/icon", pngBytes)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner upload = %d %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Guild store.Guild `json:"guild"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Guild.IconVersion < 1 || !payload.Guild.HasIcon {
		t.Fatalf("post-upload guild = %#v", payload.Guild)
	}

	rec = serveGuildHTTPGet(server, ownerToken, "/api/guilds/"+formatID(guild.ID)+"/icon")
	if rec.Code != http.StatusOK {
		t.Fatalf("get icon = %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("cache-control = %q", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("ETag") != strconv.FormatInt(int64(payload.Guild.IconVersion), 10) {
		t.Fatalf("etag = %q, want %d", rec.Header().Get("ETag"), payload.Guild.IconVersion)
	}
}

func TestGuildIconDeleteBumpsVersion(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()

	owner, err := db.CreateUser(ctx, "icon_delete_owner", "删除图标所有者", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	guild, err := db.CreateGuild(ctx, admin.ID, "删除图标服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	ownerToken, _, err := db.CreateSession(ctx, owner.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	pngBytes := validSquarePNG(t, 16)
	rec := serveGuildIconUpload(server, ownerToken, "/api/guilds/"+formatID(guild.ID)+"/icon", pngBytes)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner upload = %d %s", rec.Code, rec.Body.String())
	}
	var afterUpload struct {
		Guild store.Guild `json:"guild"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&afterUpload); err != nil {
		t.Fatal(err)
	}
	uploadVersion := afterUpload.Guild.IconVersion

	rec = serveGuildHTTPRequest(server, ownerToken, http.MethodDelete, "/api/guilds/"+formatID(guild.ID)+"/icon", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("owner delete = %d %s", rec.Code, rec.Body.String())
	}
	var afterDelete struct {
		Guild store.Guild `json:"guild"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&afterDelete); err != nil {
		t.Fatal(err)
	}
	if afterDelete.Guild.IconVersion <= uploadVersion {
		t.Fatalf("version after delete = %d, want > %d (monotonic, no reset)", afterDelete.Guild.IconVersion, uploadVersion)
	}
	if afterDelete.Guild.HasIcon {
		t.Fatalf("hasIcon after delete = true, want false")
	}

	rec = serveGuildHTTPGet(server, ownerToken, "/api/guilds/"+formatID(guild.ID)+"/icon")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "icon_not_found") {
		t.Fatalf("get icon after delete = %d %s, want 404 icon_not_found", rec.Code, rec.Body.String())
	}
}

func TestGuildIconRejectsBadImage(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	owner, err := db.CreateUser(ctx, "icon_invalid_owner", "无效图标所有者", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	guild, err := db.CreateGuild(ctx, admin.ID, "无效图标服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	ownerToken, _, err := db.CreateSession(ctx, owner.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	body, boundary := buildMultipartFile("file", []byte("not an image at all"), "image/png")
	req := httptest.NewRequest(http.MethodPost, "/api/guilds/"+formatID(guild.ID)+"/icon", strings.NewReader(body))
	req.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
	req.AddCookie(&http.Cookie{Name: "test_session", Value: ownerToken})
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "image_invalid") {
		t.Fatalf("non-image upload = %d %s, want 400 image_invalid", rec.Code, rec.Body.String())
	}
}

func TestPlatformAdminCanManageGuildIcon(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()

	owner, err := db.CreateUser(ctx, "icon_platform_owner", "平台图标所有者", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	guild, err := db.CreateGuild(ctx, admin.ID, "平台图标服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	adminToken, _, err := db.CreateSession(ctx, admin.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	ownerToken, _, err := db.CreateSession(ctx, owner.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	pngBytes := validSquarePNG(t, 32)

	rec := serveGuildIconUpload(server, adminToken, "/api/platform/guilds/"+formatID(guild.ID)+"/icon", pngBytes)
	if rec.Code != http.StatusOK {
		t.Fatalf("platform admin upload = %d %s", rec.Code, rec.Body.String())
	}

	rec = serveGuildIconUpload(server, ownerToken, "/api/platform/guilds/"+formatID(guild.ID)+"/icon", pngBytes)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-platform platform-route upload = %d, want 403", rec.Code)
	}

	rec = serveGuildHTTPRequest(server, adminToken, http.MethodDelete, "/api/platform/guilds/"+formatID(guild.ID)+"/icon", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("platform admin delete = %d %s", rec.Code, rec.Body.String())
	}

	rec = serveGuildHTTPGet(server, adminToken, "/api/guilds/"+formatID(guild.ID)+"/icon")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("get icon after platform delete = %d, want 404", rec.Code)
	}
}

func TestGuildIconGetNotFound(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()
	owner, err := db.CreateUser(ctx, "icon_fresh_owner", "全新图标所有者", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	guild, err := db.CreateGuild(ctx, admin.ID, "全新图标服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	ownerToken, _, err := db.CreateSession(ctx, owner.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	rec := serveGuildHTTPGet(server, ownerToken, "/api/guilds/"+formatID(guild.ID)+"/icon")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "icon_not_found") {
		t.Fatalf("fresh guild get icon = %d %s, want 404 icon_not_found", rec.Code, rec.Body.String())
	}
}