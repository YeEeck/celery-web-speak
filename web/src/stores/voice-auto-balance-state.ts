// 自动音量平衡——开关状态（seam 3）：localStorage 读写，仅本机生效、默认关闭。

export const AUTO_VOICE_BALANCE_KEY = 'cws.autoVoiceBalance'

export function getSavedAutoVoiceBalance(storage: Storage): boolean {
  return storage.getItem(AUTO_VOICE_BALANCE_KEY) === 'true'
}

export function saveAutoVoiceBalance(storage: Storage, value: boolean) {
  if (value) storage.setItem(AUTO_VOICE_BALANCE_KEY, 'true')
  else storage.removeItem(AUTO_VOICE_BALANCE_KEY)
}
