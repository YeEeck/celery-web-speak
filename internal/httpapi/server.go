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
	mux.Handle("GET /api/platform/servers", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformServers)))
	mux.Handle("POST /api/platform/servers", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformCreateServer)))
	mux.Handle("PATCH /api/platform/servers/{serverID}", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformRenameServer)))
	mux.Handle("PATCH /api/platform/servers/{serverID}/owner", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformServerOwner)))
	mux.Handle("DELETE /api/platform/servers/{serverID}", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformDeleteServer)))
	mux.Handle("POST /api/platform/servers/{serverID}/join", s.requirePlatformAdmin(http.HandlerFunc(s.handlePlatformJoinServer)))
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
	mux.Handle("GET /api/servers/{serverID}/bootstrap", s.requireGuildMember(http.HandlerFunc(s.handleServerBootstrap)))
	mux.Handle("PATCH /api/servers/{serverID}", s.requireGuildMember(http.HandlerFunc(s.handleServerRename)))
	mux.Handle("POST /api/servers/{serverID}/leave", s.requireGuildMember(http.HandlerFunc(s.handleServerLeave)))
	mux.Handle("GET /api/servers/{serverID}/members", s.requireGuildMember(http.HandlerFunc(s.handleServerMembers)))
	mux.Handle("POST /api/servers/{serverID}/members", s.requireGuildAdmin(http.HandlerFunc(s.handleServerAddMember)))
	mux.Handle("PATCH /api/servers/{serverID}/members/{userID}/role", s.requireGuildAdmin(http.HandlerFunc(s.handleServerMemberRole)))
	mux.Handle("PATCH /api/servers/{serverID}/members/{userID}/mute", s.requireGuildAdmin(http.HandlerFunc(s.handleServerMemberMute)))
	mux.Handle("PATCH /api/servers/{serverID}/members/{userID}/ban", s.requireGuildAdmin(http.HandlerFunc(s.handleServerMemberBan)))
	mux.Handle("DELETE /api/servers/{serverID}/members/{userID}/temporary-ban", s.requireGuildAdmin(http.HandlerFunc(s.handleServerClearTemporaryBan)))
	mux.Handle("POST /api/servers/{serverID}/members/{userID}/kick", s.requireGuildAdmin(http.HandlerFunc(s.handleServerRemoveMember)))
	mux.Handle("POST /api/servers/{serverID}/channels", s.requireGuildAdmin(http.HandlerFunc(s.handleServerChannels)))
	mux.Handle("PATCH /api/servers/{serverID}/channels/{channelID}", s.requireGuildAdmin(http.HandlerFunc(s.handleServerUpdateChannel)))
	mux.Handle("DELETE /api/servers/{serverID}/channels/{channelID}", s.requireGuildAdmin(http.HandlerFunc(s.handleServerDeleteChannel)))
	mux.Handle("GET /api/servers/{serverID}/channels/{channelID}/messages", s.requireGuildMember(http.HandlerFunc(s.handleServerMessages)))
	mux.Handle("POST /api/servers/{serverID}/channels/{channelID}/messages", s.requireGuildMember(http.HandlerFunc(s.handleServerCreateMessage)))
	mux.Handle("POST /api/servers/{serverID}/channels/{channelID}/voice/token", s.requireGuildMember(http.HandlerFunc(s.handleServerVoiceToken)))
	mux.Handle("PATCH /api/servers/{serverID}/channels/{channelID}/voice/state", s.requireGuildMember(http.HandlerFunc(s.handleServerVoiceState)))
	mux.Handle("POST /api/servers/{serverID}/voice/leave", s.requireGuildMember(http.HandlerFunc(s.handleServerVoiceLeave)))
	mux.Handle("DELETE /api/servers/{serverID}/channels/{channelID}/messages/{messageID}", s.requireGuildAdmin(http.HandlerFunc(s.handleServerDeleteMessage)))
	mux.Handle("POST /api/servers/{serverID}/channels/{channelID}/read", s.requireGuildMember(http.HandlerFunc(s.handleServerRead)))
	mux.Handle("POST /api/channels", s.requireDefaultGuildAdmin(http.HandlerFunc(s.handleCreateChannel)))
	mux.Handle("PATCH /api/channels/{id}", s.requireDefaultGuildAdmin(http.HandlerFunc(s.handleUpdateChannel)))
	mux.Handle("DELETE /api/channels/{id}", s.requireDefaultGuildAdmin(http.HandlerFunc(s.handleDeleteChannel)))
	mux.Handle("GET /api/channels/{id}/messages", s.requireDefaultGuildMember(http.HandlerFunc(s.handleListChannelMessages)))
	mux.Handle("POST /api/channels/{id}/messages", s.requireDefaultGuildMember(http.HandlerFunc(s.handleCreateChannelMessage)))
	mux.Handle("DELETE /api/channels/{channelID}/messages/{messageID}", s.requireDefaultGuildAdmin(http.HandlerFunc(s.handleDeleteChannelMessage)))
	mux.Handle("POST /api/channels/{id}/read", s.requireDefaultGuildMember(http.HandlerFunc(s.handleMarkChannelRead)))
	mux.Handle("POST /api/channels/{id}/voice/token", s.requireDefaultGuildMember(http.HandlerFunc(s.handleChannelVoiceToken)))
	mux.Handle("PATCH /api/channels/{id}/voice/state", s.requireDefaultGuildMember(http.HandlerFunc(s.handleChannelVoiceState)))
	mux.Handle("GET /api/messages", s.requireDefaultGuildMember(http.HandlerFunc(s.handleListMessages)))
	mux.Handle("POST /api/messages", s.requireDefaultGuildMember(http.HandlerFunc(s.handleCreateMessage)))
	mux.Handle("DELETE /api/messages/{id}", s.requireDefaultGuildAdmin(http.HandlerFunc(s.handleDeleteMessage)))
	mux.Handle("GET /api/ws", s.requireAuth(http.HandlerFunc(s.handleWebSocket)))
	mux.Handle("POST /api/voice/token", s.requireDefaultGuildMember(http.HandlerFunc(s.handleVoiceToken)))
	mux.Handle("POST /api/voice/leave", s.requireDefaultGuildMember(http.HandlerFunc(s.handleVoiceLeave)))
	mux.Handle("PATCH /api/voice/state", s.requireDefaultGuildMember(http.HandlerFunc(s.handleVoiceState)))
	mux.Handle("GET /api/admin/invites", s.requireServerAdmin(http.HandlerFunc(s.handleListInvites)))
	mux.Handle("GET /api/version", s.requireAuth(http.HandlerFunc(s.handleVersion)))
	mux.Handle("GET /api/changelog", s.requireAuth(http.HandlerFunc(s.handleChangelog)))
	mux.Handle("POST /api/admin/invites", s.requireServerAdmin(http.HandlerFunc(s.handleCreateInvite)))
	mux.Handle("DELETE /api/admin/invites/{id}", s.requireServerAdmin(http.HandlerFunc(s.handleRevokeInvite)))
	mux.Handle("DELETE /api/admin/invites/{id}/permanent", s.requireServerAdmin(http.HandlerFunc(s.handleDeleteInvite)))
	mux.Handle("POST /api/admin/users", s.requireServerAdmin(http.HandlerFunc(s.handleCreateUser)))
	mux.Handle("PATCH /api/admin/users/{id}/mute", s.requireAdmin(http.HandlerFunc(s.handleSetMute)))
	mux.Handle("PATCH /api/admin/users/{id}/role", s.requireServerAdmin(http.HandlerFunc(s.handleSetRole)))
	mux.Handle("POST /api/admin/users/{id}/reset-password", s.requireServerAdmin(http.HandlerFunc(s.handleResetPassword)))
	mux.Handle("POST /api/admin/users/{id}/kick", s.requireAdmin(http.HandlerFunc(s.handleKick)))
	mux.Handle("DELETE /api/admin/users/{id}/temporary-ban", s.requireAdmin(http.HandlerFunc(s.handleClearTemporaryBan)))
	mux.Handle("PATCH /api/admin/users/{id}/ban", s.requireServerAdmin(http.HandlerFunc(s.handlePermanentBan)))
	mux.Handle("DELETE /api/admin/users/{id}", s.requireServerAdmin(http.HandlerFunc(s.handleDeleteUser)))
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

func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return s.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !currentUser(r).Role.IsAdmin() {
			writeError(w, http.StatusForbidden, "forbidden", "需要频道管理员权限")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (s *Server) requireServerAdmin(next http.Handler) http.Handler {
	return s.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if currentUser(r).Role != store.RoleServerAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "需要服务器管理员权限")
			return
		}
		next.ServeHTTP(w, r)
	}))
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
