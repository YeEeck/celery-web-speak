package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/yeck/celery-web-speak/internal/store"
)

// handleUpdateMyCallReceiving persists the current user's 可被呼叫设置 and
// broadcasts the account update so every connected client of this account
// sees the same value. Only the account owner can modify it.
func (s *Server) handleUpdateMyCallReceiving(w http.ResponseWriter, r *http.Request) {
	var input struct {
		CallReceiving *bool `json:"callReceiving"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.CallReceiving == nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "callReceiving 必须为布尔值")
		return
	}
	user := currentUser(r)
	if err := s.store.SetUserCallReceiving(r.Context(), user.ID, *input.CallReceiving); err != nil {
		s.writeStoreError(w, err)
		return
	}
	user.CallReceiving = *input.CallReceiving
	s.hub.BroadcastUser(user.ID, "user_updated", user)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) handleListCallBlocks(w http.ResponseWriter, r *http.Request) {
	blocks, err := s.store.ListCallBlocks(r.Context(), currentUser(r).ID)
	if err != nil {
		s.internalError(w, "list call blocks", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"blocks": blocks})
}

func (s *Server) handleGetCallBlock(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parsePathID(w, r, "targetUserId")
	if !ok {
		return
	}
	user := currentUser(r)
	if targetID == user.ID {
		writeError(w, http.StatusBadRequest, "self_action", "不能查询自己的呼叫屏蔽")
		return
	}
	if _, err := s.store.UserByID(r.Context(), targetID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "用户不存在")
			return
		}
		s.writeStoreError(w, err)
		return
	}
	block, exists, err := s.store.CallBlock(r.Context(), user.ID, targetID)
	if err != nil {
		s.internalError(w, "read call block", err)
		return
	}
	if !exists {
		writeJSON(w, http.StatusOK, map[string]any{"block": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"block": block})
}

func (s *Server) handlePutCallBlock(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parsePathID(w, r, "targetUserId")
	if !ok {
		return
	}
	user := currentUser(r)
	if targetID == user.ID {
		writeError(w, http.StatusBadRequest, "self_action", "不能屏蔽自己")
		return
	}
	var input struct {
		Kind store.CallBlockKind `json:"kind"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Kind != store.CallBlockKindTemporary && input.Kind != store.CallBlockKindPermanent {
		writeError(w, http.StatusBadRequest, "invalid_request", "屏蔽类型无效")
		return
	}
	if _, err := s.store.UserByID(r.Context(), targetID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "用户不存在")
			return
		}
		s.writeStoreError(w, err)
		return
	}
	_, exists, err := s.store.CallBlock(r.Context(), user.ID, targetID)
	if err != nil {
		s.internalError(w, "read call block for upsert", err)
		return
	}
	if !exists {
		shared, err := s.store.SharedGuild(r.Context(), user.ID, targetID)
		if err != nil {
			s.internalError(w, "check shared guild for call block", err)
			return
		}
		if !shared {
			writeError(w, http.StatusForbidden, "not_in_shared_guild", "只能屏蔽与你有共同服务器的成员")
			return
		}
	}
	block, err := s.store.SetCallBlock(r.Context(), user.ID, targetID, input.Kind)
	if err != nil {
		s.internalError(w, "set call block", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"block": block})
}

func (s *Server) handleDeleteCallBlock(w http.ResponseWriter, r *http.Request) {
	targetID, ok := parsePathID(w, r, "targetUserId")
	if !ok {
		return
	}
	user := currentUser(r)
	if targetID == user.ID {
		writeError(w, http.StatusBadRequest, "self_action", "不能屏蔽自己")
		return
	}
	// 解除屏蔽幂等返回 204（重复删除同一目标同样成功）。
	if err := s.store.DeleteCallBlock(r.Context(), user.ID, targetID); err != nil {
		s.internalError(w, "delete call block", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleCallBlockCandidates(w http.ResponseWriter, r *http.Request) {
	// 规格：前缀匹配 @用户名/显示名称——用户习惯带 @ 输入，归一化后按用户名匹配。
	query := strings.TrimPrefix(strings.TrimSpace(r.URL.Query().Get("q")), "@")
	if query == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "搜索关键字不能为空")
		return
	}
	candidates, err := s.store.CallBlockCandidates(r.Context(), currentUser(r).ID, query)
	if err != nil {
		s.internalError(w, "search call block candidates", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": candidates})
}
