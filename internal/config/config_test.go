package config

import (
	"strings"
	"testing"
	"time"
)

func TestVoiceReconcileInterval(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "key")
	t.Setenv("LIVEKIT_API_SECRET", "secret")
	t.Setenv("COOKIE_SECURE", "false")

	for _, test := range []struct {
		name    string
		value   string
		want    time.Duration
		wantErr string
	}{
		{name: "default", want: 15 * time.Second},
		{name: "custom", value: "30s", want: 30 * time.Second},
		{name: "disabled", value: "0", want: 0},
		{name: "invalid", value: "soon", wantErr: "VOICE_RECONCILE_INTERVAL"},
		{name: "negative", value: "-1s", wantErr: "must not be negative"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("VOICE_RECONCILE_INTERVAL", test.value)
			cfg, err := Load()
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("Load() error = %v, want substring %q", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if cfg.VoiceReconcileInterval != test.want {
				t.Fatalf("VoiceReconcileInterval = %s, want %s", cfg.VoiceReconcileInterval, test.want)
			}
		})
	}
}
