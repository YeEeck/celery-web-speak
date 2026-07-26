package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/yeck/celery-web-speak/internal/config"
	"github.com/yeck/celery-web-speak/internal/media"
	"github.com/yeck/celery-web-speak/internal/store"
	"github.com/yeck/celery-web-speak/internal/webui"
)

type contextKey int

const userContextKey contextKey = iota

type Server struct {
	cfg                   config.Config
	store                 *store.Store
	media                 *media.Service
	hub                   *Hub
	logger                *slog.Logger
	limiterMu             sync.Mutex
	limits                map[int64][]time.Time
	voiceReconcileMu      sync.Mutex
	voiceRefreshMu        sync.Mutex
	voiceRefreshScheduled bool
	upgrader              websocket.Upgrader
}

func New(cfg config.Config, db *store.Store, mediaService *media.Service, logger *slog.Logger) *Server {
	s := &Server{
		cfg:    cfg,
		store:  db,
		media:  mediaService,
		hub:    NewHub(),
		logger: logger,
		limits: make(map[int64][]time.Time),
	}
	s.upgrader = websocket.Upgrader{
		HandshakeTimeout: 10 * time.Second,
		CheckOrigin:      s.checkOrigin,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	s.reconcileVoiceRooms(ctx, "startup")
	cancel()
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/livekit/webhook", s.handleLiveKitWebhook)
	mux.Handle("POST /api/auth/logout", s.requireAuth(http.HandlerFunc(s.handleLogout)))
	mux.Handle("GET /api/me", s.requireAuth(http.HandlerFunc(s.handleMe)))
	mux.Handle("PATCH /api/me", s.requireAuth(http.HandlerFunc(s.handleUpdateMe)))
	mux.Handle("GET /api/bootstrap", s.requireAuth(http.HandlerFunc(s.handleBootstrap)))
	mux.Handle("GET /api/platform/guilds", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformGuilds)))
	mux.Handle("POST /api/platform/guilds", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformCreateGuild)))
	mux.Handle("PATCH /api/platform/guilds/{guildID}", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformRenameGuild)))
	mux.Handle("PATCH /api/platform/guilds/{guildID}/owner", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformGuildOwner)))
	mux.Handle("DELETE /api/platform/guilds/{guildID}", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformDeleteGuild)))
	mux.Handle("POST /api/platform/guilds/{guildID}/join", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformJoinGuild)))
	mux.Handle("GET /api/platform/users", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformUsers)))
	mux.Handle("POST /api/platform/users", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformCreateUser)))
	mux.Handle("PATCH /api/platform/users/{id}/role", s.requirePlatformAdmin(http.HandlerFunc(s.handleSetPlatformRole)))
	mux.Handle("POST /api/platform/users/{id}/reset-password", s.requirePlatformAdmin(http.HandlerFunc(s.handleResetPassword)))
	mux.Handle("PATCH /api/platform/users/{id}/suspend", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformSuspend)))
	mux.Handle("DELETE /api/platform/users/{id}", s.requirePlatformAdmin(http.HandlerFunc(s.handleDeleteUser)))
	mux.Handle("GET /api/platform/invites", s.requirePlatformAdmin(http.HandlerFunc(s.handleListInvites)))
	mux.Handle("POST /api/platform/invites", s.requirePlatformAdmin(http.HandlerFunc(s.handleCreateInvite)))
	mux.Handle("DELETE /api/platform/invites/{id}", s.requirePlatformAdmin(http.HandlerFunc(s.handleRevokeInvite)))
	mux.Handle("DELETE /api/platform/invites/{id}/permanent", s.requirePlatformAdmin(http.HandlerFunc(s.handleDeleteInvite)))
	mux.Handle("GET /api/guilds/{guildID}/bootstrap", s.requireGuildMember(http.HandlerFunc(s.handleGuildBootstrap)))
	mux.Handle("PATCH /api/guilds/{guildID}", s.requireGuildMember(http.HandlerFunc(s.handleGuildRename)))
	mux.Handle("POST /api/guilds/{guildID}/leave", s.requireGuildMember(http.HandlerFunc(s.handleGuildLeave)))
	mux.Handle("GET /api/guilds/{guildID}/members", s.requireGuildMember(http.HandlerFunc(s.handleGuildMembers)))
	mux.Handle("POST /api/guilds/{guildID}/members", s.requireGuildAdmin(http.HandlerFunc(s.handleGuildAddMember)))
	mux.Handle("PATCH /api/guilds/{guildID}/members/{userID}/role", s.requireGuildAdmin(http.HandlerFunc(s.handleGuildMemberRole)))
	mux.Handle("PATCH /api/guilds/{guildID}/members/{userID}/mute", s.requireGuildAdmin(http.HandlerFunc(s.handleGuildMemberMute)))
	mux.Handle("PATCH /api/guilds/{guildID}/members/{userID}/ban", s.requireGuildAdmin(http.HandlerFunc(s.handleGuildMemberBan)))
	mux.Handle("DELETE /api/guilds/{guildID}/members/{userID}/temporary-ban", s.requireGuildAdmin(http.HandlerFunc(s.handleGuildClearTemporaryBan)))
	mux.Handle("POST /api/guilds/{guildID}/members/{userID}/kick", s.requireGuildAdmin(http.HandlerFunc(s.handleGuildRemoveMember)))
	mux.Handle("POST /api/guilds/{guildID}/channels", s.requireGuildAdmin(http.HandlerFunc(s.handleGuildChannels)))
	mux.Handle("PATCH /api/guilds/{guildID}/channels/{channelID}", s.requireGuildAdmin(http.HandlerFunc(s.handleGuildUpdateChannel)))
	mux.Handle("DELETE /api/guilds/{guildID}/channels/{channelID}", s.requireGuildAdmin(http.HandlerFunc(s.handleGuildDeleteChannel)))
	mux.Handle("GET /api/guilds/{guildID}/channels/{channelID}/messages", s.requireGuildMember(http.HandlerFunc(s.handleGuildMessages)))
	mux.Handle("POST /api/guilds/{guildID}/channels/{channelID}/messages", s.requireGuildMember(http.HandlerFunc(s.handleGuildCreateMessage)))
	mux.Handle("POST /api/guilds/{guildID}/channels/{channelID}/voice/token", s.requireGuildMember(http.HandlerFunc(s.handleGuildVoiceToken)))
	mux.Handle("PATCH /api/guilds/{guildID}/channels/{channelID}/voice/state", s.requireGuildMember(http.HandlerFunc(s.handleGuildVoiceState)))
	mux.Handle("POST /api/guilds/{guildID}/voice/leave", s.requireGuildMember(http.HandlerFunc(s.handleGuildVoiceLeave)))
	mux.Handle("DELETE /api/guilds/{guildID}/channels/{channelID}/messages/{messageID}", s.requireGuildAdmin(http.HandlerFunc(s.handleGuildDeleteMessage)))
	mux.Handle("POST /api/guilds/{guildID}/channels/{channelID}/read", s.requireGuildMember(http.HandlerFunc(s.handleGuildRead)))
	mux.Handle("GET /api/ws", s.requireAuth(http.HandlerFunc(s.handleWebSocket)))
	mux.Handle("GET /api/version", s.requireAuth(http.HandlerFunc(s.handleVersion)))
	mux.Handle("GET /api/changelog", s.requireAuth(http.HandlerFunc(s.handleChangelog)))
	mux.Handle("/api/", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "接口不存在")
	}))
	mux.Handle("/", s.frontendHandler())
	return s.securityHeaders(s.logRequests(mux))
}

func (s *Server) frontendHandler() http.Handler {
	dist, err := fs.Sub(webui.Files, "dist")
	if err != nil {
		panic(err)
	}
	files := http.FileServerFS(dist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "请求方法不受支持")
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path != "" {
			if _, err := fs.Stat(dist, path); err == nil {
				files.ServeHTTP(w, r)
				return
			}
		}
		r.URL.Path = "/"
		files.ServeHTTP(w, r)
	})
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(s.cfg.CookieName)
		if err != nil || cookie.Value == "" {
			writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
			return
		}
		user, err := s.store.UserBySession(r.Context(), cookie.Value)
		if err != nil {
			clearCookie(w, s.cfg)
			if errors.Is(err, store.ErrBanned) {
				writeError(w, http.StatusForbidden, "banned", "账号当前无法进入")
			} else {
				writeError(w, http.StatusUnauthorized, "unauthorized", "登录已过期")
			}
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userContextKey, user)))
	})
}

func currentUser(r *http.Request) store.User {
	return r.Context().Value(userContextKey).(store.User)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求内容格式不正确")
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求只能包含一个 JSON 对象")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": code, "message": message})
}

func parseID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	return parsePathID(w, r, "id")
}

func parsePathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil || id < 1 {
		writeError(w, http.StatusBadRequest, "invalid_id", "用户或资源编号无效")
		return 0, false
	}
	return id, true
}

func (s *Server) checkOrigin(r *http.Request) bool {
	origin := strings.TrimRight(r.Header.Get("Origin"), "/")
	if origin == "" {
		return false
	}
	if len(s.cfg.TrustedOrigins) > 0 {
		for _, allowed := range s.cfg.TrustedOrigins {
			if origin == allowed {
				return true
			}
		}
		return false
	}
	parsed, err := url.Parse(origin)
	return err == nil && strings.EqualFold(parsed.Host, r.Host)
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(self)")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		if !strings.HasPrefix(r.URL.Path, "/api/health") {
			s.logger.Info("http request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(started))
		}
	})
}
