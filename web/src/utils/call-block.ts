// 暂时屏蔽剩余时长的统一展示：个人信息卡片与通话设置页共用同一文案规则。
export function callBlockRemainingLabel(expiresAt: string | undefined, now = Date.now()): string {
  if (!expiresAt) return ''
  const ms = new Date(expiresAt).getTime() - now
  if (ms <= 0) return '已到期'
  const minutes = Math.ceil(ms / 60000)
  if (minutes < 60) return `${minutes} 分钟后解除`
  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return `${hours} 小时后解除`
  return `${Math.ceil(hours / 24)} 天后解除`
}

// 暂时屏蔽剩余时长的实时倒计时（个人信息卡片 pill 用）：H:MM:SS，小时不补零、
// 分秒补零；按秒向上取整，归零前不会显示 0。
export function formatCallBlockCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${hours}:${pad(minutes)}:${pad(seconds)}`
}
