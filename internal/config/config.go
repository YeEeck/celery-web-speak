package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr                   string
	DatabasePath           string
	CookieName             string
	CookieSecure           bool
	SessionTTL             time.Duration
	BootstrapAdminUsername string
	BootstrapAdminPassword string
	LiveKitURL             string
	LiveKitPublicURL       string
	LiveKitAPIKey          string
	LiveKitAPISecret       string
	TrustedOrigins         []string
	VoiceReconcileInterval time.Duration
}

func Load() (Config, error) {
	secure, err := strconv.ParseBool(env("COOKIE_SECURE", "true"))
	if err != nil {
		return Config{}, fmt.Errorf("COOKIE_SECURE: %w", err)
	}
	reconcileInterval, err := time.ParseDuration(env("VOICE_RECONCILE_INTERVAL", "15s"))
	if err != nil {
		return Config{}, fmt.Errorf("VOICE_RECONCILE_INTERVAL: %w", err)
	}
	if reconcileInterval < 0 {
		return Config{}, fmt.Errorf("VOICE_RECONCILE_INTERVAL must not be negative")
	}

	cfg := Config{
		Addr:                   env("ADDR", ":8080"),
		DatabasePath:           env("DATABASE_PATH", "./data/celery.db"),
		CookieName:             env("SESSION_COOKIE_NAME", "celery_session"),
		CookieSecure:           secure,
		SessionTTL:             30 * 24 * time.Hour,
		BootstrapAdminUsername: strings.TrimSpace(os.Getenv("BOOTSTRAP_ADMIN_USERNAME")),
		BootstrapAdminPassword: os.Getenv("BOOTSTRAP_ADMIN_PASSWORD"),
		LiveKitURL:             env("LIVEKIT_URL", "http://livekit:7880"),
		LiveKitPublicURL:       strings.TrimRight(env("LIVEKIT_PUBLIC_URL", "ws://localhost:7880"), "/"),
		LiveKitAPIKey:          strings.TrimSpace(os.Getenv("LIVEKIT_API_KEY")),
		LiveKitAPISecret:       os.Getenv("LIVEKIT_API_SECRET"),
		TrustedOrigins:         splitList(os.Getenv("TRUSTED_ORIGINS")),
		VoiceReconcileInterval: reconcileInterval,
	}

	if cfg.LiveKitAPIKey == "" || cfg.LiveKitAPISecret == "" {
		return Config{}, fmt.Errorf("LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required")
	}
	return cfg, nil
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func splitList(value string) []string {
	var result []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, strings.TrimRight(item, "/"))
		}
	}
	return result
}
