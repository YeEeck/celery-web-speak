package httpapi

import (
	"errors"
	"net/http"

	"github.com/yeck/celery-web-speak/internal/media"
)

// hubCallSignaler adapts the hub's point-to-point SendUser into the media
// CallSignaler interface, so state-machine signalling events are delivered to
// the addressed account's own connections.
type hubCallSignaler struct {
	hub *Hub
}

func (h hubCallSignaler) EmitCallSignal(targetUserID int64, signal media.CallSignal) {
	h.hub.SendUser(targetUserID, signal.Type, signal)
}

func (s *Server) handleCallCreate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		CalleeUserID int64 `json:"calleeUserId"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	caller := currentUser(r)
	if input.CalleeUserID == caller.ID {
		writeError(w, http.StatusBadRequest, "self_call", "不能呼叫自己")
		return
	}
	callee, err := s.store.UserByID(r.Context(), input.CalleeUserID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	shared, err := s.store.SharedGuild(r.Context(), caller.ID, callee.ID)
	if err != nil {
		s.internalError(w, "check shared guild for call", err)
		return
	}
	// 被叫资格与在线判定分开仲裁（spec 02/14）：不同服是资格拒绝，离线才是
	// unreachable，避免把「不能呼叫」误报成「对方不在线」。
	if !shared {
		writeError(w, http.StatusForbidden, "not_in_shared_guild", "只能呼叫与你有共同服务器的成员")
		return
	}
	reachable := s.hub.IsOnline(callee.ID)
	result, err := s.media.StartCall(caller, callee, reachable)
	if err != nil {
		s.writeCallError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleCallAction(action func(callID, userID int64) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		callID, ok := parsePathID(w, r, "callId")
		if !ok {
			return
		}
		if err := action(callID, currentUser(r).ID); err != nil {
			s.writeCallError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *Server) handleCallAccept(w http.ResponseWriter, r *http.Request) {
	s.handleCallAction(s.media.AcceptCall)(w, r)
}

func (s *Server) handleCallReject(w http.ResponseWriter, r *http.Request) {
	s.handleCallAction(s.media.RejectCall)(w, r)
}

func (s *Server) handleCallCancel(w http.ResponseWriter, r *http.Request) {
	s.handleCallAction(s.media.CancelCall)(w, r)
}

func (s *Server) handleCallHangup(w http.ResponseWriter, r *http.Request) {
	s.handleCallAction(s.media.HangUpCall)(w, r)
}

func (s *Server) handleCallToken(w http.ResponseWriter, r *http.Request) {
	callID, ok := parsePathID(w, r, "callId")
	if !ok {
		return
	}
	user := currentUser(r)
	peerID, isParty := s.media.CallPeer(callID, user.ID)
	if !isParty {
		writeError(w, http.StatusForbidden, "forbidden", "不是该通话的参与者")
		return
	}
	credentials, err := s.media.JoinCallCredentials(r.Context(), user, callID, peerID)
	if err != nil {
		if errors.Is(err, media.ErrCallNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "通话不存在")
			return
		}
		if errors.Is(err, media.ErrCallNotActive) {
			writeError(w, http.StatusConflict, "call_not_active", "通话已不在通话中状态")
			return
		}
		s.internalError(w, "create call token", err)
		return
	}
	writeJSON(w, http.StatusOK, credentials)
}

func (s *Server) writeCallError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, media.ErrCallNotFound):
		writeError(w, http.StatusNotFound, "not_found", "通话不存在")
	case errors.Is(err, media.ErrCallWrongParty):
		writeError(w, http.StatusForbidden, "forbidden", "不是该通话的参与者")
	case errors.Is(err, media.ErrCallNotRinging):
		writeError(w, http.StatusConflict, "call_not_ringing", "通话已不在振铃状态")
	case errors.Is(err, media.ErrCallNotActive):
		writeError(w, http.StatusConflict, "call_not_active", "通话已不在通话中状态")
	case errors.Is(err, media.ErrCallBusy):
		writeError(w, http.StatusConflict, "call_in_progress", "已有通话在进行中")
	default:
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
	}
}
