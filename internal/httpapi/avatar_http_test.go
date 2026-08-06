package httpapi

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

// validGIF builds a minimal valid GIF of the given dimensions, passing
// server-side header validation.
func validGIF(t *testing.T, w, h int) []byte {
	t.Helper()
	palette := color.Palette{color.RGBA{R: 0xff, A: 0xff}, color.RGBA{G: 0xff, A: 0xff}}
	img := image.NewPaletted(image.Rect(0, 0, w, h), palette)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetColorIndex(x, y, uint8((x+y)%2))
		}
	}
	var buf bytes.Buffer
	if err := gif.Encode(&buf, img, nil); err != nil {
		t.Fatalf("encode gif: %v", err)
	}
	return buf.Bytes()
}

// rectPNG builds a minimal valid PNG of the given dimensions.
func rectPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, color.RGBA{R: uint8(x * 255 / w), G: uint8(y * 255 / h), B: 64, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func serveAvatarUpload(server *Server, token string, content []byte, contentType string) *httptest.ResponseRecorder {
	body, boundary := buildMultipartFile("file", content, contentType)
	req := httptest.NewRequest(http.MethodPost, "/api/me/avatar", strings.NewReader(body))
	req.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
	req.AddCookie(&http.Cookie{Name: "test_session", Value: token})
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	return rec
}

func TestAvatarUploadAcceptsSquareGIF(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	token := mustSessionToken(t, db, admin.ID)

	rec := serveAvatarUpload(server, token, validGIF(t, 4, 4), "image/gif")
	if rec.Code != http.StatusOK {
		t.Fatalf("gif avatar upload = %d %s, want 200", rec.Code, rec.Body.String())
	}

	rec = serveGuildHTTPGet(server, token, "/api/users/"+formatID(admin.ID)+"/avatar")
	if rec.Code != http.StatusOK {
		t.Fatalf("get avatar = %d %s, want 200", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/gif" {
		t.Fatalf("avatar content-type = %q, want image/gif", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("cache-control = %q", got)
	}
}

func TestAvatarUploadAcceptsNonSquareGIF(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)

	rec := serveAvatarUpload(server, mustSessionToken(t, db, admin.ID), validGIF(t, 2, 1), "image/gif")
	if rec.Code != http.StatusOK {
		t.Fatalf("non-square gif avatar upload = %d %s, want 200", rec.Code, rec.Body.String())
	}
}

func TestAvatarUploadRejectsNonSquarePNG(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)

	rec := serveAvatarUpload(server, mustSessionToken(t, db, admin.ID), rectPNG(t, 2, 1), "image/png")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "正方形") {
		t.Fatalf("non-square png avatar upload = %d %s, want 400 正方形", rec.Code, rec.Body.String())
	}
}

func TestAvatarUploadRejectsOversize(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)

	oversize := append(rectPNG(t, 16, 16), make([]byte, 8<<20)...)
	rec := serveAvatarUpload(server, mustSessionToken(t, db, admin.ID), oversize, "image/png")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "8 MB") {
		t.Fatalf("oversize avatar upload = %d %s, want 400 8 MB", rec.Code, rec.Body.String())
	}
}

func TestGuildIconUploadRejectsGIF(t *testing.T) {
	db, admin, server := newGuildHTTPTestServer(t)
	ctx := context.Background()

	owner, err := db.CreateUser(ctx, "icon_gif_owner", "图标所有者", "another-secure-password", store.RoleMember)
	if err != nil {
		t.Fatal(err)
	}
	guild, err := db.CreateGuild(ctx, admin.ID, "图标服务器", owner.Username)
	if err != nil {
		t.Fatal(err)
	}
	ownerToken, _, err := db.CreateSession(ctx, owner.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	rec := serveGuildIconUpload(server, ownerToken, "/api/guilds/"+formatID(guild.ID)+"/icon", validGIF(t, 4, 4))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "仅支持 PNG、JPEG、WebP") {
		t.Fatalf("gif guild icon upload = %d %s, want 400 仅支持 PNG、JPEG、WebP", rec.Code, rec.Body.String())
	}
}
