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
