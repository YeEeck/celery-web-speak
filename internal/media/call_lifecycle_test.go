package media

import (
	"context"
	"errors"
	"testing"
	"time"

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

func TestStartCallRingingEmitsInviteToCallee(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	result := service.StartCall(caller(), callee(), true)
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

	result := service.StartCall(caller(), callee(), false)
	if result.State != CallEnded || result.Reason != CallEndUnreachable {
		t.Fatalf("start result = %+v, want ended(unreachable)", result)
	}
	call := service.calls[result.CallID]
	if call == nil || call.State != CallEnded || call.EndReason != CallEndUnreachable {
		t.Fatalf("call = %+v", call)
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
	service.StartCall(caller(), callee(), true)
	signaler.signals = nil

	third := store.User{ID: 300, Username: "third", DisplayName: "第三者"}
	result := service.StartCall(third, callee(), true)
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
	service.StartCall(caller(), callee(), true)
	signaler.signals = nil

	// B dials back A; A is already in a ringing call -> busy to B.
	result := service.StartCall(callee(), caller(), true)
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

func TestAcceptAdvancesToActiveAndSignalsCaller(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)

	result := service.StartCall(caller(), callee(), true)
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
	result := service.StartCall(caller(), callee(), true)
	signaler.signals = nil

	if err := service.RejectCall(result.CallID, 200); err != nil {
		t.Fatalf("reject: %v", err)
	}
	call := service.calls[result.CallID]
	if call.State != CallEnded || call.EndReason != CallEndRejected {
		t.Fatalf("call = %+v, want ended(rejected)", call)
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
	result := service.StartCall(caller(), callee(), true)
	signaler.signals = nil

	if err := service.CancelCall(result.CallID, 100); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	call := service.calls[result.CallID]
	if call.State != CallEnded || call.EndReason != CallEndCanceled {
		t.Fatalf("call = %+v, want ended(canceled)", call)
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
	result := service.StartCall(caller(), callee(), true)
	if err := service.AcceptCall(result.CallID, 200); err != nil {
		t.Fatalf("accept: %v", err)
	}
	signaler.signals = nil

	if err := service.HangUpCall(result.CallID, 100); err != nil {
		t.Fatalf("hangup: %v", err)
	}
	call := service.calls[result.CallID]
	if call.State != CallEnded || call.EndReason != CallEndNormal {
		t.Fatalf("call = %+v, want ended(ended)", call)
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
	result := service.StartCall(caller(), callee(), true)
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

	result := service.StartCall(caller(), callee(), true)
	signaler.signals = nil

	// Fire the scheduled timeout callback.
	select {
	case fn := <-scheduled:
		fn()
	case <-time.After(time.Second):
		t.Fatal("timeout not scheduled")
	}

	call := service.calls[result.CallID]
	if call.State != CallEnded || call.EndReason != CallEndTimeout {
		t.Fatalf("call = %+v, want ended(timeout)", call)
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

	result := service.StartCall(caller(), callee(), true)
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

func TestTransitionErrors(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	result := service.StartCall(caller(), callee(), true)

	if err := service.AcceptCall(result.CallID, 100); !errors.Is(err, ErrCallWrongParty) {
		t.Fatalf("accept by caller error = %v, want ErrCallWrongParty", err)
	}
	if err := service.CancelCall(999999, 100); !errors.Is(err, ErrCallNotFound) {
		t.Fatalf("cancel missing call error = %v, want ErrCallNotFound", err)
	}
	// Reject then accept: not ringing.
	if err := service.RejectCall(result.CallID, 200); err != nil {
		t.Fatalf("reject: %v", err)
	}
	if err := service.AcceptCall(result.CallID, 200); !errors.Is(err, ErrCallNotRinging) {
		t.Fatalf("accept after ended error = %v, want ErrCallNotRinging", err)
	}
	if err := service.HangUpCall(result.CallID, 200); !errors.Is(err, ErrCallNotActive) {
		t.Fatalf("hangup while ended error = %v, want ErrCallNotActive", err)
	}
}

func TestActiveParticipantLeftEndsDisconnected(t *testing.T) {
	service := newLifecycleService()
	signaler := &recordingSignaler{}
	service.SetCallSignaler(signaler)
	result := service.StartCall(caller(), callee(), true)
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
