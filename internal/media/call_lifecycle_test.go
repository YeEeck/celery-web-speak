package media

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"github.com/yeck/celery-web-speak/internal/store"
)

type recordedSignal struct {
	CallSignal
	TargetUserID int64
}

type recordingSignaler struct {
	signals []recordedSignal
}

func (r *recordingSignaler) EmitCallSignal(targetUserID int64, signal CallSignal) {
	r.signals = append(r.signals, recordedSignal{CallSignal: signal, TargetUserID: targetUserID})
}

func caller() store.User { return store.User{ID: 100, Username: "caller", DisplayName: "主叫"} }
func callee() store.User { return store.User{ID: 200, Username: "callee", DisplayName: "被叫"} }

func newLifecycleService() *Service {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	service.now = func() time.Time { return time.Date(2026, time.July, 21, 3, 0, 0, 0, time.UTC) }
	return service
}

// mustStart runs StartCall and fails the test on an unexpected refusal.
func mustStart(t *testing.T, service *Service, caller, callee store.User, reachable bool) StartCallResult {
	t.Helper()
	callee.CallReceiving = true
	result, err := service.StartCall(caller, callee, CallStartFacts{Shared: true, Blocked: false, Reachable: reachable})
	if err != nil {
		t.Fatalf("start call: %v", err)
	}
	return result
}

func TestStartCallNotSharedReturnsQualificationRefusal(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	want := callee()
	want.CallReceiving = true
	if _, err := service.StartCall(caller(), want, CallStartFacts{Shared: false, Blocked: false, Reachable: true}); !errors.Is(err, ErrCallNotInSharedGuild) {
		t.Fatalf("not-shared start error = %v, want ErrCallNotInSharedGuild", err)
	}
	if len(service.calls) != 0 {
		t.Fatalf("calls tracked = %d, want none (资格拒绝 must not create a call)", len(service.calls))
	}
	if len(signaler.signals) != 0 {
		t.Fatalf("signals = %+v, want none (资格拒绝 must not signal)", signaler.signals)
	}
}

func TestStartCallNotSharedBeatsCallerBusy(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	mustStart(t, service, caller(), callee(), true)
	signaler.signals = nil

	third := store.User{ID: 300, Username: "third", DisplayName: "第三者", CallReceiving: true}
	if _, err := service.StartCall(caller(), third, CallStartFacts{Shared: false, Blocked: false, Reachable: true}); !errors.Is(err, ErrCallNotInSharedGuild) {
		t.Fatalf("busy+not-shared error = %v, want ErrCallNotInSharedGuild", err)
	}
	if len(service.calls) != 1 {
		t.Fatalf("calls tracked = %d, want 1", len(service.calls))
	}
	if len(signaler.signals) != 0 {
		t.Fatalf("signals = %+v, want none", signaler.signals)
	}
}

func TestStartCallInboundNotAllowedReturnsUnavailable(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	result, err := service.StartCall(caller(), callee(), CallStartFacts{Shared: true, Blocked: false, Reachable: true})
	if err != nil {
		t.Fatalf("start call with 可被呼叫设置 off: %v", err)
	}
	if result.State != CallEnded || result.Reason != CallEndUnavailable {
		t.Fatalf("start result = %+v, want ended(unavailable)", result)
	}
	if len(service.calls) != 0 {
		t.Fatalf("terminal unavailable call remained tracked: %+v", service.calls)
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_unavailable to caller", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 100 || sig.Type != "call_unavailable" || sig.State != CallEnded || sig.Reason != CallEndUnavailable {
		t.Fatalf("signal = %+v, want call_unavailable to caller", sig)
	}
	if sig.Peer.UserID != 200 {
		t.Fatalf("signal peer = %+v, want callee", sig.Peer)
	}
}

func TestStartCallBlockedReturnsUnavailable(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	want := callee()
	want.CallReceiving = true
	result, err := service.StartCall(caller(), want, CallStartFacts{Shared: true, Blocked: true, Reachable: true})
	if err != nil {
		t.Fatalf("start call with 呼叫屏蔽: %v", err)
	}
	if result.State != CallEnded || result.Reason != CallEndUnavailable {
		t.Fatalf("start result = %+v, want ended(unavailable)", result)
	}
	if len(service.calls) != 0 {
		t.Fatalf("terminal unavailable call remained tracked: %+v", service.calls)
	}
	if len(signaler.signals) != 1 || signaler.signals[0].Type != "call_unavailable" {
		t.Fatalf("signals = %+v, want 1 call_unavailable", signaler.signals)
	}
}

func TestStartCallBlockedBeatsUnreachable(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	want := callee()
	want.CallReceiving = true
	result, err := service.StartCall(caller(), want, CallStartFacts{Shared: true, Blocked: true, Reachable: false})
	if err != nil {
		t.Fatalf("start call blocked+offline: %v", err)
	}
	if result.State != CallEnded || result.Reason != CallEndUnavailable {
		t.Fatalf("blocked+offline result = %+v, want ended(unavailable)", result)
	}
	if len(signaler.signals) != 1 || signaler.signals[0].Type != "call_unavailable" {
		t.Fatalf("signals = %+v, want call_unavailable not call_unreachable", signaler.signals)
	}
}

func TestStartCallRingingEmitsInviteToCallee(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	result := mustStart(t, service, caller(), callee(), true)
	if result.State != CallRinging || result.Reason != "" {
		t.Fatalf("start result = %+v, want ringing", result)
	}
	if result.CallID <= 0 {
		t.Fatalf("callID = %d, want positive", result.CallID)
	}
	call := service.calls[result.CallID]
	if call == nil || call.State != CallRinging || call.CallerID != 100 || call.CalleeID != 200 {
		t.Fatalf("call = %+v", call)
	}
	if call.Caller.UserID != 100 || call.Caller.Username != "caller" || call.Caller.DisplayName != "主叫" {
		t.Fatalf("stored caller = %+v", call.Caller)
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_invite", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 200 || sig.Type != "call_invite" || sig.CallID != result.CallID {
		t.Fatalf("invite signal = %+v", sig)
	}
	if sig.Peer.UserID != 100 || sig.Peer.Username != "caller" {
		t.Fatalf("invite peer = %+v", sig.Peer)
	}
}

func TestStartCallUnreachableEndsImmediately(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	result := mustStart(t, service, caller(), callee(), false)
	if result.State != CallEnded || result.Reason != CallEndUnreachable {
		t.Fatalf("start result = %+v, want ended(unreachable)", result)
	}
	if _, exists := service.calls[result.CallID]; exists {
		t.Fatalf("unreachable call remained in calls")
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_unreachable", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 100 || sig.Type != "call_unreachable" || sig.Reason != CallEndUnreachable {
		t.Fatalf("unreachable signal = %+v", sig)
	}
}

func TestStartCallBusyWhenCalleeAlreadyRinging(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	// First call leaves 200 as callee (ringing) -> busy.
	mustStart(t, service, caller(), callee(), true)
	signaler.signals = nil

	third := store.User{ID: 300, Username: "third", DisplayName: "第三者"}
	result := mustStart(t, service, third, callee(), true)
	if result.State != CallEnded || result.Reason != CallEndBusy {
		t.Fatalf("start result = %+v, want ended(busy)", result)
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_busy", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 300 || sig.Type != "call_busy" || sig.Reason != CallEndBusy {
		t.Fatalf("busy signal = %+v", sig)
	}
}

func TestMutualDialLaterArrivalIsBusy(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	// A calls B (ringing).
	mustStart(t, service, caller(), callee(), true)
	signaler.signals = nil

	// B dials back A; A is already in a ringing call -> busy to B.
	result := mustStart(t, service, callee(), caller(), true)
	if result.State != CallEnded || result.Reason != CallEndBusy {
		t.Fatalf("mutual dial result = %+v, want ended(busy)", result)
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_busy", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 200 || sig.Type != "call_busy" {
		t.Fatalf("mutual dial busy signal = %+v", sig)
	}
}

func TestStartCallRefusedWhenCallerBusyElsewhere(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	// A calls B (ringing): A is now a party to a call with B.
	mustStart(t, service, caller(), callee(), true)
	signaler.signals = nil

	// A dials a third party C while still in the call with B: refused (spec 04
	// 忙碌 = 已有任一通话). No call is created and nothing is signalled.
	third := store.User{ID: 300, Username: "third", DisplayName: "第三者"}
	if _, err := service.StartCall(caller(), third, CallStartFacts{Shared: true, Blocked: false, Reachable: true}); !errors.Is(err, ErrCallBusy) {
		t.Fatalf("caller-busy start error = %v, want ErrCallBusy", err)
	}
	if len(service.calls) != 1 {
		t.Fatalf("calls tracked = %d, want 1 (refused initiation must not create a call)", len(service.calls))
	}
	if len(signaler.signals) != 0 {
		t.Fatalf("signals = %+v, want none (refused initiation must not signal)", signaler.signals)
	}
}

func TestStartCallAllowsMutualDialToCallee(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	// A calls B (ringing). B then dials A: the caller-busy guard must not fire
	// for a call toward the very party the existing call involves (spec 04
	// 双方互拨：后到判忙——由被叫侧 busy 分支判定).
	mustStart(t, service, caller(), callee(), true)
	signaler.signals = nil

	result := mustStart(t, service, callee(), caller(), true)
	if result.State != CallEnded || result.Reason != CallEndBusy {
		t.Fatalf("mutual dial result = %+v, want ended(busy)", result)
	}
}

func TestJoinCallCredentialsRequiresActive(t *testing.T) {
	service := newLifecycleService()
	result := mustStart(t, service, caller(), callee(), true)

	// Ringing: credential issuance must be refused.
	if _, err := service.JoinCallCredentials(context.Background(), caller(), result.CallID, 200); !errors.Is(err, ErrCallNotActive) {
		t.Fatalf("ringing join credentials error = %v, want ErrCallNotActive", err)
	}

	// Accept then issue: allowed.
	if err := service.AcceptCall(result.CallID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	credentials, err := service.JoinCallCredentials(context.Background(), caller(), result.CallID, 200)
	if err != nil {
		t.Fatalf("active join credentials: %v", err)
	}
	if credentials.RoomName != CallRoomName(result.CallID) {
		t.Fatalf("room name = %q, want %q", credentials.RoomName, CallRoomName(result.CallID))
	}
}

func TestAcceptAdvancesToActiveAndSignalsCaller(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	result := mustStart(t, service, caller(), callee(), true)
	signaler.signals = nil

	if err := service.AcceptCall(result.CallID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	call := service.calls[result.CallID]
	if call.State != CallActive {
		t.Fatalf("call state = %v, want active", call.State)
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_accept", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 100 || sig.Type != "call_accept" {
		t.Fatalf("accept signal = %+v", sig)
	}
	if sig.Peer.UserID != 200 || sig.Peer.Username != "callee" {
		t.Fatalf("accept peer = %+v, want callee", sig.Peer)
	}
}

func TestRejectEndsRejectedAndSignalsCaller(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	result := mustStart(t, service, caller(), callee(), true)
	signaler.signals = nil

	if err := service.RejectCall(result.CallID, 200); err != nil {
		t.Fatalf("reject: %v", err)
	}
	if _, exists := service.calls[result.CallID]; exists {
		t.Fatalf("rejected call remained in calls")
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_reject", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 100 || sig.Type != "call_reject" {
		t.Fatalf("reject signal = %+v", sig)
	}
}

func TestCancelEndsCanceledAndSignalsCallee(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	result := mustStart(t, service, caller(), callee(), true)
	signaler.signals = nil

	if err := service.CancelCall(result.CallID, 100); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if _, exists := service.calls[result.CallID]; exists {
		t.Fatalf("canceled call remained in calls")
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_cancel", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 200 || sig.Type != "call_cancel" {
		t.Fatalf("cancel signal = %+v", sig)
	}
}

func TestHangUpEndsAndSignalsOtherParty(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	result := mustStart(t, service, caller(), callee(), true)
	if err := service.AcceptCall(result.CallID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	generation := uint64(time.Now().UnixNano())
	service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantJoined, result.CallID, 100, generation))
	service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantJoined, result.CallID, 200, generation))
	signaler.signals = nil

	if err := service.HangUpCall(result.CallID, 100); err != nil {
		t.Fatalf("hangup: %v", err)
	}
	call := service.calls[result.CallID]
	if call == nil || call.State != CallEnded || call.EndReason != CallEndNormal {
		t.Fatalf("call after hangup (participants present) = %+v, want ended(ended)", call)
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_end", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 200 || sig.Type != "call_end" || sig.Reason != CallEndNormal {
		t.Fatalf("end signal = %+v", sig)
	}
	if sig.Peer.UserID != 100 || sig.Peer.Username != "caller" {
		t.Fatalf("end peer = %+v, want caller (the hanger-up)", sig.Peer)
	}
}

func TestHangUpByCalleeSignalsCaller(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	result := mustStart(t, service, caller(), callee(), true)
	if err := service.AcceptCall(result.CallID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	signaler.signals = nil

	if err := service.HangUpCall(result.CallID, 200); err != nil {
		t.Fatalf("hangup: %v", err)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 100 || sig.Type != "call_end" {
		t.Fatalf("end signal = %+v", sig)
	}
}

func TestRingTimeoutEndsAndSignalsBoth(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	scheduled := make(chan func(), 1)
	service.schedule = func(delay time.Duration, fn func()) {
		if delay != callRingTimeout {
			t.Fatalf("timeout delay = %v, want %v", delay, callRingTimeout)
		}
		scheduled <- fn
	}

	result := mustStart(t, service, caller(), callee(), true)
	signaler.signals = nil

	// Fire the scheduled timeout callback.
	select {
	case fn := <-scheduled:
		fn()
	case <-time.After(time.Second):
		t.Fatal("timeout not scheduled")
	}

	if _, exists := service.calls[result.CallID]; exists {
		t.Fatalf("timed-out call remained in calls")
	}
	if len(signaler.signals) != 2 {
		t.Fatalf("signals = %+v, want 2 call_timeout", signaler.signals)
	}
	seen := map[int64]string{}
	for _, sig := range signaler.signals {
		if sig.Type != "call_timeout" {
			t.Fatalf("timeout signal type = %q, want call_timeout", sig.Type)
		}
		seen[sig.TargetUserID] = sig.Type
	}
	if seen[100] == "" || seen[200] == "" {
		t.Fatalf("timeout did not reach both parties: %+v", signaler.signals)
	}
}

func TestTimeoutAfterAcceptIsNoOp(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	scheduled := make(chan func(), 1)
	service.schedule = func(_ time.Duration, fn func()) { scheduled <- fn }

	result := mustStart(t, service, caller(), callee(), true)
	if err := service.AcceptCall(result.CallID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	signaler.signals = nil

	var fn func()
	select {
	case fn = <-scheduled:
	case <-time.After(time.Second):
		t.Fatal("timeout not scheduled")
	}
	fn()

	call := service.calls[result.CallID]
	if call.State != CallActive {
		t.Fatalf("call state = %v, want active (timeout must not fire after accept)", call.State)
	}
	if len(signaler.signals) != 0 {
		t.Fatalf("unexpected signals after accept: %+v", signaler.signals)
	}
}

func TestTerminalCallEvictedWhenNoParticipants(t *testing.T) {
	// A terminal ringing call (never built a room, never had participants) must
	// be evicted from s.calls immediately after its terminal signal is emitted.
	t.Run("reject", func(t *testing.T) {
		service := newLifecycleService()
		signaler := &recordingSignaler{}
		service.SetCallSignaler(signaler)
		result := mustStart(t, service, caller(), callee(), true)
		signaler.signals = nil
		if err := service.RejectCall(result.CallID, 200); err != nil {
			t.Fatalf("reject: %v", err)
		}
		if _, exists := service.calls[result.CallID]; exists {
			t.Fatalf("rejected call remained in calls")
		}
		if len(signaler.signals) != 1 || signaler.signals[0].Type != "call_reject" {
			t.Fatalf("signals = %+v, want 1 call_reject", signaler.signals)
		}
		// The terminal signal's peer must survive the eviction (emit before delete).
		if signaler.signals[0].Peer.UserID != 200 {
			t.Fatalf("reject peer = %+v, want callee (200)", signaler.signals[0].Peer)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		service := newLifecycleService()
		signaler := &recordingSignaler{}
		service.SetCallSignaler(signaler)
		result := mustStart(t, service, caller(), callee(), true)
		signaler.signals = nil
		if err := service.CancelCall(result.CallID, 100); err != nil {
			t.Fatalf("cancel: %v", err)
		}
		if _, exists := service.calls[result.CallID]; exists {
			t.Fatalf("canceled call remained in calls")
		}
		if len(signaler.signals) != 1 || signaler.signals[0].Type != "call_cancel" {
			t.Fatalf("signals = %+v, want 1 call_cancel", signaler.signals)
		}
		if signaler.signals[0].Peer.UserID != 100 {
			t.Fatalf("cancel peer = %+v, want caller (100)", signaler.signals[0].Peer)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		service := newLifecycleService()
		signaler := &recordingSignaler{}
		service.SetCallSignaler(signaler)
		scheduled := make(chan func(), 1)
		service.schedule = func(_ time.Duration, fn func()) { scheduled <- fn }
		result := mustStart(t, service, caller(), callee(), true)
		signaler.signals = nil
		var fn func()
		select {
		case fn = <-scheduled:
		case <-time.After(time.Second):
			t.Fatal("timeout not scheduled")
		}
		fn()
		if _, exists := service.calls[result.CallID]; exists {
			t.Fatalf("timed-out call remained in calls")
		}
		if len(signaler.signals) != 2 {
			t.Fatalf("signals = %+v, want 2 call_timeout", signaler.signals)
		}
	})
	t.Run("unreachable", func(t *testing.T) {
		service := newLifecycleService()
		signaler := &recordingSignaler{}
		service.SetCallSignaler(signaler)
		result := mustStart(t, service, caller(), callee(), false)
		if _, exists := service.calls[result.CallID]; exists {
			t.Fatalf("unreachable call remained in calls")
		}
		if len(signaler.signals) != 1 || signaler.signals[0].Type != "call_unreachable" {
			t.Fatalf("signals = %+v, want 1 call_unreachable", signaler.signals)
		}
		if signaler.signals[0].Peer.UserID != 200 {
			t.Fatalf("unreachable peer = %+v, want callee (200)", signaler.signals[0].Peer)
		}
	})
	t.Run("busy", func(t *testing.T) {
		service := newLifecycleService()
		signaler := &recordingSignaler{}
		service.SetCallSignaler(signaler)
		// Occupy the callee with a ringing call so the second start is busy.
		mustStart(t, service, caller(), callee(), true)
		signaler.signals = nil
		third := store.User{ID: 300, Username: "third", DisplayName: "第三者"}
		result := mustStart(t, service, third, callee(), true)
		if _, exists := service.calls[result.CallID]; exists {
			t.Fatalf("busy call remained in calls")
		}
		if len(signaler.signals) != 1 || signaler.signals[0].Type != "call_busy" {
			t.Fatalf("signals = %+v, want 1 call_busy", signaler.signals)
		}
		if signaler.signals[0].Peer.UserID != 200 {
			t.Fatalf("busy peer = %+v, want callee (200)", signaler.signals[0].Peer)
		}
	})
}

func TestHangUpRetainsCallUntilParticipantsLeave(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	result := mustStart(t, service, caller(), callee(), true)
	if err := service.AcceptCall(result.CallID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	generation := uint64(time.Now().UnixNano())
	service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantJoined, result.CallID, 100, generation))
	service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantJoined, result.CallID, 200, generation))
	signaler.signals = nil

	// Hang up: ended but participants still present -> call retained.
	if err := service.HangUpCall(result.CallID, 100); err != nil {
		t.Fatalf("hangup: %v", err)
	}
	if c := service.calls[result.CallID]; c == nil || c.State != CallEnded {
		t.Fatalf("hung-up call should remain while participants present: %+v", c)
	}

	// Both parties leave -> call evicted.
	service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantLeft, result.CallID, 100, generation))
	service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantLeft, result.CallID, 200, generation))
	if _, exists := service.calls[result.CallID]; exists {
		t.Fatalf("call remained after both participants left")
	}
}

func TestDisconnectedRetainedUntilOtherLeaves(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	result := mustStart(t, service, caller(), callee(), true)
	if err := service.AcceptCall(result.CallID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	generation := uint64(time.Now().UnixNano())
	service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantJoined, result.CallID, 100, generation))
	service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantJoined, result.CallID, 200, generation))
	signaler.signals = nil

	// Callee drops: disconnected, caller still present -> retained.
	if !service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantLeft, result.CallID, 200, generation)) {
		t.Fatal("active call participant leave did not change snapshot")
	}
	if c := service.calls[result.CallID]; c == nil || c.State != CallEnded || c.EndReason != CallEndDisconnected {
		t.Fatalf("disconnected call should remain while peer present: %+v", c)
	}

	// Caller leaves -> evicted.
	service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantLeft, result.CallID, 100, generation))
	if _, exists := service.calls[result.CallID]; exists {
		t.Fatalf("call remained after last participant left")
	}
}

func TestTransitionErrors(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	result := mustStart(t, service, caller(), callee(), true)

	if err := service.AcceptCall(result.CallID, 100); !errors.Is(err, ErrCallWrongParty) {
		t.Fatalf("accept by caller error = %v, want ErrCallWrongParty", err)
	}
	if err := service.CancelCall(999999, 100); !errors.Is(err, ErrCallNotFound) {
		t.Fatalf("cancel missing call error = %v, want ErrCallNotFound", err)
	}
	// Reject evicts the participant-less terminal call; later actions on the
	// same callID then report not-found rather than a stale-state error.
	if err := service.RejectCall(result.CallID, 200); err != nil {
		t.Fatalf("reject: %v", err)
	}
	if err := service.AcceptCall(result.CallID, 200); !errors.Is(err, ErrCallNotFound) {
		t.Fatalf("accept after rejected error = %v, want ErrCallNotFound", err)
	}
	if err := service.HangUpCall(result.CallID, 200); !errors.Is(err, ErrCallNotFound) {
		t.Fatalf("hangup after rejected error = %v, want ErrCallNotFound", err)
	}
}

func TestActiveParticipantLeftEndsDisconnected(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	result := mustStart(t, service, caller(), callee(), true)
	if err := service.AcceptCall(result.CallID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	generation := uint64(time.Now().UnixNano())
	// Both parties join the room (active call in progress).
	service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantJoined, result.CallID, 100, generation))
	service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantJoined, result.CallID, 200, generation))
	signaler.signals = nil

	// Callee's connection drops (terminal leave) during active -> disconnected.
	if !service.ApplyWebhook(context.Background(), callParticipantEvent(webhook.EventParticipantLeft, result.CallID, 200, generation)) {
		t.Fatal("active call participant leave did not change snapshot")
	}
	call := service.calls[result.CallID]
	if call.State != CallEnded || call.EndReason != CallEndDisconnected {
		t.Fatalf("call = %+v, want ended(disconnected)", call)
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_end to caller", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 100 || sig.Type != "call_end" || sig.Reason != CallEndDisconnected {
		t.Fatalf("disconnect signal = %+v", sig)
	}
}
func TestRefreshEvictsEndedExpiredCallsOnly(t *testing.T) {
	service := New("http://127.0.0.1:1", "ws://127.0.0.1:7880", "key", "secret")
	now := time.Date(2026, time.July, 21, 3, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	service.room = &listingRoomService{}

	// ended + expired -> evicted by Refresh.
	expiredEnded := newRingingCall(t, service, 100, 200)
	service.calls[expiredEnded].State = CallEnded
	service.calls[expiredEnded].EndReason = CallEndRejected
	service.calls[expiredEnded].ExpiresAt = now.Add(-time.Minute)

	// active + expired -> retained (calls may outlive the creation TTL).
	expiredActive := newRingingCall(t, service, 300, 400)
	service.calls[expiredActive].State = CallActive
	service.calls[expiredActive].ExpiresAt = now.Add(-time.Minute)

	// ringing (not expired) -> retained.
	ringing := newRingingCall(t, service, 500, 600)

	if _, err := service.Refresh(context.Background()); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if _, exists := service.calls[expiredEnded]; exists {
		t.Fatalf("ended+expired call survived Refresh")
	}
	if _, exists := service.calls[expiredActive]; !exists {
		t.Fatalf("active+expired call was evicted by Refresh")
	}
	if _, exists := service.calls[ringing]; !exists {
		t.Fatalf("ringing call was evicted by Refresh")
	}
}

func voiceParticipantInfo(userID int64, generation uint64) *livekit.ParticipantInfo {
	return &livekit.ParticipantInfo{
		Identity: Identity(userID),
		Name:     fmt.Sprintf("通话成员-%d", userID),
		Attributes: map[string]string{
			"user_id":                fmt.Sprint(userID),
			"call_id":                fmt.Sprint(1),
			VoiceGenerationAttribute: fmt.Sprint(generation),
		},
	}
}

func setRecordedCallParticipants(c *call, userIDs ...int64) {
	c.Participants = make(map[int64]VoiceParticipant, len(userIDs))
	for _, userID := range userIDs {
		c.Participants[userID] = VoiceParticipant{UserID: userID, Identity: Identity(userID), Generation: 7}
	}
}

type recordingListingRoomService struct {
	listingRoomService
	removed *livekit.RoomParticipantIdentity
}

func (r *recordingListingRoomService) RemoveParticipant(_ context.Context, participant *livekit.RoomParticipantIdentity) (*livekit.RemoveParticipantResponse, error) {
	r.removed = participant
	return &livekit.RemoveParticipantResponse{}, nil
}

func TestRefreshMarksPreviouslyObservedAbsentPartyDisconnected(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	callID := newRingingCall(t, service, 100, 200)
	if err := service.AcceptCall(callID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	setRecordedCallParticipants(service.calls[callID], 100, 200)
	service.room = &listingRoomService{
		rooms: []*livekit.Room{{Name: CallRoomName(callID)}},
		participants: map[string][]*livekit.ParticipantInfo{
			CallRoomName(callID): {voiceParticipantInfo(200, 7)},
		},
	}
	signaler.signals = nil

	if _, err := service.Refresh(context.Background()); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	call := service.calls[callID]
	if call == nil || call.State != CallEnded || call.EndReason != CallEndDisconnected {
		t.Fatalf("call after refresh = %+v, want ended(disconnected)", call)
	}
	if len(call.Participants) != 1 {
		t.Fatalf("participants after refresh = %+v, want only remaining party", call.Participants)
	}
	if _, ok := call.Participants[200]; !ok {
		t.Fatalf("remaining party missing from participants: %+v", call.Participants)
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_end to remaining party", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 200 || sig.Type != "call_end" || sig.Reason != CallEndDisconnected {
		t.Fatalf("disconnect signal = %+v", sig)
	}
	if sig.Peer.UserID != 100 {
		t.Fatalf("disconnect peer = %+v, want absent caller", sig.Peer)
	}
}

func TestRefreshDoesNotDisconnectBeforeFirstObservation(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	callID := newRingingCall(t, service, 100, 200)
	if err := service.AcceptCall(callID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	signaler.signals = nil
	// The call room has not been built yet: accept happened, token/join is
	// still in flight. Refresh sees no call room, but no party was recorded
	// before, so this must stay active.
	service.room = &listingRoomService{}

	if _, err := service.Refresh(context.Background()); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	call := service.calls[callID]
	if call == nil || call.State != CallActive || len(call.Participants) != 0 {
		t.Fatalf("call after refresh = %+v, want untouched active", call)
	}
	if len(signaler.signals) != 0 {
		t.Fatalf("signals = %+v, want none during join window", signaler.signals)
	}
}

func TestWebhookAuthoritativeLeftDisconnectsWhenJoinWasMissed(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	callID := newRingingCall(t, service, 100, 200)
	if err := service.AcceptCall(callID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	// Only the callee's join was recorded; the caller's join webhook was lost.
	setRecordedCallParticipants(service.calls[callID], 200)
	signaler.signals = nil

	left := callParticipantEvent(webhook.EventParticipantLeft, callID, 100, 7)
	if !service.ApplyWebhook(context.Background(), left) {
		t.Fatal("authoritative left did not change snapshot")
	}
	call := service.calls[callID]
	if call == nil || call.State != CallEnded || call.EndReason != CallEndDisconnected {
		t.Fatalf("call after authoritative left = %+v, want ended(disconnected)", call)
	}
	if len(signaler.signals) != 1 {
		t.Fatalf("signals = %+v, want 1 call_end to recorded peer", signaler.signals)
	}
	sig := signaler.signals[0]
	if sig.TargetUserID != 200 || sig.Type != "call_end" || sig.Reason != CallEndDisconnected {
		t.Fatalf("disconnect signal = %+v", sig)
	}
	if sig.Peer.UserID != 100 {
		t.Fatalf("disconnect peer = %+v, want caller", sig.Peer)
	}
}

func TestObservationTransitionAdmissionAndEffectOrder(t *testing.T) {
	now := time.Date(2026, time.July, 21, 3, 0, 0, 0, time.UTC)
	current := &call{
		CallID:    77,
		CallerID:  100,
		CalleeID:  200,
		Caller:    CallParty{UserID: 100, Username: "caller", DisplayName: "主叫"},
		Callee:    CallParty{UserID: 200, Username: "callee", DisplayName: "被叫"},
		State:     CallActive,
		ExpiresAt: now.Add(time.Minute),
	}
	setRecordedCallParticipants(current, 100, 200)
	observed := map[int64]VoiceParticipant{
		200: {UserID: 200, Identity: Identity(200), Generation: 9},
		999: {UserID: 999, Identity: Identity(999), Generation: 0},
	}

	next, effects := transitionCallParticipants(current, observed, 0, now, map[int64]callTarget{})
	if next == nil || next.State != CallEnded || next.EndReason != CallEndDisconnected {
		t.Fatalf("next call = %+v, want ended(disconnected)", next)
	}
	if len(next.Participants) != 1 {
		t.Fatalf("next participants = %+v, want only admitted callee", next.Participants)
	}
	if len(effects) != 2 {
		t.Fatalf("effects = %+v, want removal then signal", effects)
	}
	if effects[0].kind != callEffectRemoveParticipant {
		t.Fatalf("effect[0] = %+v, want remove participant", effects[0])
	}
	if effects[0].roomName != CallRoomName(77) || effects[0].identity != Identity(999) {
		t.Fatalf("remove effect = %+v", effects[0])
	}
	if effects[1].kind != callEffectEmitSignal {
		t.Fatalf("effect[1] = %+v, want emit signal", effects[1])
	}
	if effects[1].targetUserID != 200 || effects[1].signal.Type != "call_end" || effects[1].signal.Reason != CallEndDisconnected {
		t.Fatalf("signal effect = %+v", effects[1])
	}
	if effects[1].signal.Peer.UserID != 100 {
		t.Fatalf("signal peer = %+v, want materialized caller party", effects[1].signal.Peer)
	}
}

func TestRefreshAdmissionRemovesIllegalCallParticipant(t *testing.T) {
	service := newLifecycleService()
	callID := newRingingCall(t, service, 100, 200)
	room := &recordingListingRoomService{
		listingRoomService: listingRoomService{
			rooms: []*livekit.Room{{Name: CallRoomName(callID)}},
			participants: map[string][]*livekit.ParticipantInfo{
				CallRoomName(callID): {voiceParticipantInfo(999, 0)},
			},
		},
	}
	service.room = room

	if _, err := service.Refresh(context.Background()); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if room.removed == nil || room.removed.Room != CallRoomName(callID) || room.removed.Identity != Identity(999) {
		t.Fatalf("remove request = %+v, want illegal participant", room.removed)
	}
	if call := service.calls[callID]; call == nil || len(call.Participants) != 0 {
		t.Fatalf("call = %+v, illegal participant must not be recorded", call)
	}
}

func TestRefreshEndedCallBookkeeping(t *testing.T) {
	t.Run("observed participant retained without signals", func(t *testing.T) {
		service := newLifecycleService()
		signaler := &recordingSignaler{}
		service.SetCallSignaler(signaler)
		callID := newRingingCall(t, service, 100, 200)
		call := service.calls[callID]
		call.State = CallEnded
		call.EndReason = CallEndNormal
		call.ExpiresAt = service.now().Add(time.Minute)
		setRecordedCallParticipants(call, 100)
		signaler.signals = nil
		service.room = &listingRoomService{
			rooms: []*livekit.Room{{Name: CallRoomName(callID)}},
			participants: map[string][]*livekit.ParticipantInfo{
				CallRoomName(callID): {voiceParticipantInfo(100, 7)},
			},
		}

		if _, err := service.Refresh(context.Background()); err != nil {
			t.Fatalf("refresh: %v", err)
		}
		if call := service.calls[callID]; call == nil || call.State != CallEnded || len(call.Participants) != 1 {
			t.Fatalf("call after refresh = %+v, want ended with observed participant", call)
		}
		if len(signaler.signals) != 0 {
			t.Fatalf("signals = %+v, want none for ended bookkeeping", signaler.signals)
		}
	})

	t.Run("absent observed participant evicts empty ended call", func(t *testing.T) {
		service := newLifecycleService()
		signaler := &recordingSignaler{}
		service.SetCallSignaler(signaler)
		callID := newRingingCall(t, service, 100, 200)
		call := service.calls[callID]
		call.State = CallEnded
		call.EndReason = CallEndNormal
		call.ExpiresAt = service.now().Add(time.Minute)
		setRecordedCallParticipants(call, 100)
		signaler.signals = nil
		service.room = &listingRoomService{}

		if _, err := service.Refresh(context.Background()); err != nil {
			t.Fatalf("refresh: %v", err)
		}
		if _, exists := service.calls[callID]; exists {
			t.Fatalf("ended call with no observed participants survived Refresh")
		}
		if len(signaler.signals) != 0 {
			t.Fatalf("signals = %+v, want none for ended eviction", signaler.signals)
		}
	})
}

func TestRefreshBothPartiesAbsentEndsSilently(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	callID := newRingingCall(t, service, 100, 200)
	if err := service.AcceptCall(callID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	setRecordedCallParticipants(service.calls[callID], 100, 200)
	signaler.signals = nil
	service.room = &listingRoomService{}

	if _, err := service.Refresh(context.Background()); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if _, exists := service.calls[callID]; exists {
		t.Fatalf("active call survived Refresh with both parties absent")
	}
	if len(signaler.signals) != 0 {
		t.Fatalf("signals = %+v, want silent eviction when no peer remains", signaler.signals)
	}
}
