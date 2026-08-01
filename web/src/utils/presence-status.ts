import type { PresenceStatus } from '../types'

// presenceStatusFor 统一查询某用户的在线状态：自己取本地计算的自身状态，
// 其他人取 presence 广播数据，无数据视为离线。
export function presenceStatusFor(
  userId: number,
  selfUserId: number | null,
  ownStatus: PresenceStatus,
  remoteStatuses: Record<number, PresenceStatus>,
): PresenceStatus {
  if (userId === selfUserId) return ownStatus
  return remoteStatuses[userId] ?? 'offline'
}
