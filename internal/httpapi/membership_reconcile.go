package httpapi

import (
	"context"
	"time"
)

const (
	membershipReconcileInterval = 30 * time.Second
	membershipReconcileTimeout  = 5 * time.Second
)

func (s *Server) RunGuildMembershipReconciler(ctx context.Context) {
	s.schedulePendingGuildMembershipRestores(ctx)
	s.reconcileExpiredGuildMemberships(ctx, "startup")
	ticker := time.NewTicker(membershipReconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.reconcileExpiredGuildMemberships(ctx, "periodic")
		}
	}
}

func (s *Server) schedulePendingGuildMembershipRestores(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, membershipReconcileTimeout)
	defer cancel()
	members, err := s.store.ListPendingGuildMembershipRestores(ctx, time.Now())
	if err != nil {
		s.logger.Warn("list pending guild membership restores", "error", err)
		return
	}
	for _, member := range members {
		s.scheduleGuildMembershipRestore(member.TemporaryBanUntil)
	}
}

func (s *Server) reconcileExpiredGuildMemberships(parent context.Context, source string) {
	ctx, cancel := context.WithTimeout(parent, membershipReconcileTimeout)
	defer cancel()
	members, err := s.store.RestoreExpiredGuildMemberships(ctx, time.Now())
	if err != nil {
		s.logger.Warn("restore expired guild memberships", "source", source, "error", err)
		return
	}
	for _, member := range members {
		s.hub.AddUserGuild(member.UserID, member.GuildID)
		s.hub.BroadcastGuild(member.GuildID, "member_updated", member)
	}
}

func (s *Server) scheduleGuildMembershipRestore(until *time.Time) {
	if until == nil {
		return
	}
	delay := time.Until(*until)
	if delay < 0 {
		delay = 0
	}
	time.AfterFunc(delay, func() {
		s.reconcileExpiredGuildMemberships(context.Background(), "timer")
	})
}
