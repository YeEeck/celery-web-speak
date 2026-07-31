import { ApiError } from './api'
import type { GuildRole, User, UserProfile, VoiceProgress } from './types'

export const MAX_VOICE_XP = 1_000_000_000

export type CommandFeedbackTone = 'success' | 'error'

export interface CommandFeedback {
  id: string
  createdAt: string
  tone: CommandFeedbackTone
  title: string
  body: string
}

export interface SlashSuggestion {
  id: string
  label: string
  description: string
  value: string
}

export interface SlashCommandContext {
  guildId: number | null
  currentUser: User | null
  guildRole: GuildRole | null
  isPlatformAdmin: boolean
  members: User[]
  getProfile: (userId: number, guildId: number) => Promise<UserProfile>
  setVoiceXP: (guildId: number, userId: number, xp: number) => Promise<VoiceXPSetResponse>
}

export interface VoiceXPSetResponse {
  target: { id: number; username: string }
  before: VoiceProgress
  after: VoiceProgress
}

export type SlashSubmitResult =
  | { kind: 'message'; content: string }
  | { kind: 'feedback'; feedback: CommandFeedback; clearInput: boolean }

let feedbackSequence = 0

export function isSlashInput(input: string): boolean {
  return input.trimStart().startsWith('/')
}

export function getSlashSuggestions(input: string, context: SlashCommandContext): SlashSuggestion[] {
  const value = input.trimStart()
  if (!value.startsWith('/') || value.startsWith('//')) return []

  const body = value.slice(1)
  const tokens = body.split(/\s+/)
  const trailingSpace = /\s$/.test(body)
  const root = tokens[0]?.toLowerCase() ?? ''

  if (tokens.length === 1 && !trailingSpace) {
    const suggestions: SlashSuggestion[] = []
    if ('xp'.startsWith(root)) suggestions.push({ id: 'xp', label: '/xp', description: '服务器语音经验', value: '/xp ' })
    return suggestions
  }

  if (root !== 'xp') return []
  const canSet = canUseSet(context)
  const subcommand = tokens[1]?.toLowerCase() ?? ''
  if (tokens.length <= 2 && (trailingSpace || subcommand !== 'get' && subcommand !== 'set')) {
    const suggestions: SlashSuggestion[] = []
    if ('get'.startsWith(subcommand)) suggestions.push({ id: 'xp-get', label: '/xp get', description: '查询服务器语音经验', value: '/xp get ' })
    if (canSet && 'set'.startsWith(subcommand)) suggestions.push({ id: 'xp-set', label: '/xp set', description: '设置成员服务器语音经验', value: '/xp set ' })
    return suggestions
  }

  if (subcommand !== 'get' && subcommand !== 'set') return []
  const expectsTarget = subcommand === 'set' || tokens.length >= 3
  if (!expectsTarget || tokens.length > 3) return []
  const typed = tokens[2] ?? ''
  if (typed && !typed.startsWith('@')) return []
  const query = typed.slice(1).toLocaleLowerCase()
  const candidates = context.members
    .filter((member) => isActiveMember(member))
    .filter((member) => subcommand !== 'set' || canManageTarget(context, member))
    .filter((member) => member.username.toLocaleLowerCase().startsWith(query))
  if (!trailingSpace && candidates.length === 1 && candidates[0]?.username.toLocaleLowerCase() === query) return []
  const tokenStart = value.lastIndexOf(typed)
  const prefix = tokenStart >= 0 ? value.slice(0, tokenStart) : `${value} `
  return candidates.map((member) => ({
    id: `${subcommand}-member-${member.id}`,
    label: `@${member.username}`,
    description: member.displayName,
    value: `${prefix}@${member.username} `,
  }))
}

export async function submitSlashCommand(input: string, context: SlashCommandContext): Promise<SlashSubmitResult> {
  const value = input.trim()
  if (!value.startsWith('/')) return { kind: 'message', content: value }
  if (value.startsWith('//')) return { kind: 'message', content: value.slice(1) }

  const feedback = (title: string, body: string, clearInput = false): SlashSubmitResult => ({
    kind: 'feedback',
    feedback: createFeedback('error', title, body),
    clearInput,
  })
  if (context.guildId === null || context.currentUser === null) return feedback('无法执行指令', '当前没有可用的服务器。')

  const body = value.slice(1)
  const tokens = body.split(/\s+/)
  const root = tokens[0]?.toLowerCase() ?? ''
  if (!root) return feedback('未知指令', availableCommands(context))
  if (root !== 'xp') return feedback('未知指令', availableCommands(context))

  const subcommand = tokens[1]?.toLowerCase() ?? ''
  if (subcommand !== 'get' && subcommand !== 'set') return feedback('未知子指令', availableCommands(context))
  if (subcommand === 'get') return submitGet(tokens, value, context, feedback)
  return submitSet(tokens, value, context, feedback)
}

function submitGet(
  tokens: string[],
  value: string,
  context: SlashCommandContext,
  feedback: (title: string, body: string, clearInput?: boolean) => SlashSubmitResult,
): Promise<SlashSubmitResult> {
  if (tokens.length > 3 || tokens.length < 2) return Promise.resolve(feedback('参数错误', '用法：/xp get [@登录名]'))
  const target = tokens.length === 2 ? context.currentUser : findTarget(tokens[2], context)
  if (!target) return Promise.resolve(feedback('找不到成员', '请使用当前服务器中仍活跃的唯一登录名。'))
  return context.getProfile(target.id, context.guildId!).then((profile): SlashSubmitResult => {
    const progress = profile.voiceProgress
    if (!progress) return feedback('查询失败', '服务器语音经验暂时不可用。')
    return {
      kind: 'feedback',
      feedback: createFeedback('success', '服务器语音经验', formatGetFeedback(profile.username, progress)),
      clearInput: true,
    }
  }).catch((error) => feedbackFromError(error, value, '查询失败'))
}

function submitSet(
  tokens: string[],
  value: string,
  context: SlashCommandContext,
  feedback: (title: string, body: string, clearInput?: boolean) => SlashSubmitResult,
): Promise<SlashSubmitResult> {
  if (!canUseSet(context)) return Promise.resolve(feedback('权限不足', '你没有设置服务器语音经验的权限。'))
  if (tokens.length !== 4) return Promise.resolve(feedback('参数错误', '用法：/xp set @登录名 <xp>'))
  const target = findTarget(tokens[2], context)
  if (!target || !canManageTarget(context, target)) return Promise.resolve(feedback('找不到成员', '请使用当前服务器中你有权管理的活跃成员登录名。'))
  const rawXP = tokens[3]
  if (!/^[0-9]+$/.test(rawXP)) return Promise.resolve(feedback('参数错误', 'XP 必须是 0 到 1000000000 的整数。'))
  const xp = Number(rawXP)
  if (!Number.isSafeInteger(xp) || xp < 0 || xp > MAX_VOICE_XP) return Promise.resolve(feedback('参数错误', 'XP 必须是 0 到 1000000000 的整数。'))
  return context.setVoiceXP(context.guildId!, target.id, xp).then((result): SlashSubmitResult => ({
    kind: 'feedback',
    feedback: createFeedback('success', '服务器语音经验已设置', formatSetFeedback(result)),
    clearInput: true,
  })).catch((error) => feedbackFromError(error, value, '设置失败'))
}

function findTarget(token: string | undefined, context: SlashCommandContext): User | null {
  if (!token || !/^@[A-Za-z0-9_-]{3,32}$/.test(token)) return null
  const username = token.slice(1).toLocaleLowerCase()
  return context.members.find((member) => isActiveMember(member) && member.username.toLocaleLowerCase() === username) ?? null
}

function isActiveMember(member: User): boolean {
  if (member.permanentlyBanned) return false
  return !member.temporaryBanUntil || new Date(member.temporaryBanUntil).getTime() <= Date.now()
}

function canUseSet(context: SlashCommandContext): boolean {
  return context.guildRole === 'owner' || context.guildRole === 'admin' || context.isPlatformAdmin
}

function canManageTarget(context: SlashCommandContext, target: User): boolean {
  if (!canUseSet(context)) return false
  if (target.role === 'owner') return context.guildRole === 'owner' && context.currentUser?.id === target.id
  if (target.role === 'admin') return context.guildRole === 'owner' || context.isPlatformAdmin
  return true
}

function availableCommands(context: SlashCommandContext): string {
  return canUseSet(context) ? '可用指令：/xp get、/xp set @登录名 <xp>' : '可用指令：/xp get'
}

function formatGetFeedback(username: string, progress: VoiceProgress): string {
  const earned = progress.xp - progress.levelStartXp
  const needed = Math.max(0, progress.levelEndXp - progress.levelStartXp)
  return `@${username}\n总 XP：${progress.xp}\n等级：Lv.${progress.level}\n当前等级进度：${earned}/${needed}`
}

function formatSetFeedback(result: VoiceXPSetResponse): string {
  return `@${result.target.username}\n修改前：${result.before.xp} XP（Lv.${result.before.level}）\n修改后：${result.after.xp} XP（Lv.${result.after.level}）`
}

function feedbackFromError(error: unknown, _command: string, fallbackTitle: string): SlashSubmitResult {
  const body = error instanceof ApiError && error.message ? error.message : '服务器暂时无法处理该指令。'
  return { kind: 'feedback', feedback: createFeedback('error', fallbackTitle, body), clearInput: false }
}

function createFeedback(tone: CommandFeedbackTone, title: string, body: string): CommandFeedback {
  return {
    id: `command-feedback-${Date.now()}-${++feedbackSequence}`,
    createdAt: new Date().toISOString(),
    tone,
    title,
    body,
  }
}
