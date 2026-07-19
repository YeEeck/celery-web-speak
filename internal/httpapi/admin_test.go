package httpapi

import (
	"testing"
	"time"

	"github.com/yeck/celery-web-speak/internal/store"
)

func TestInviteCursorRoundTrip(t *testing.T) {
	want := &store.InviteCursor{
		Active:   true,
		SortTime: time.Date(2026, time.July, 20, 8, 30, 0, 0, time.UTC),
		ID:       42,
	}
	got, ok := decodeInviteCursor(encodeInviteCursor(want))
	if !ok {
		t.Fatal("encoded invite cursor was rejected")
	}
	if got.Active != want.Active || !got.SortTime.Equal(want.SortTime) || got.ID != want.ID {
		t.Fatalf("decoded cursor = %+v, want %+v", got, want)
	}
}

func TestInviteCursorRejectsInvalidValues(t *testing.T) {
	for _, value := range []string{"%%%", "e30", "eyJpZCI6LTF9"} {
		if _, ok := decodeInviteCursor(value); ok {
			t.Fatalf("invalid cursor %q was accepted", value)
		}
	}
}
