import { ApiError } from './api.ts'
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
}

export interface SlashCommandActions {
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

interface ParsedSlashInput {
  value: string
  tokens: string[]
  trailingSpace: boolean
  root: string
}

type SlashCommandExecutor = (
  parsed: ParsedSlashInput,
  context: SlashCommandContext,
  actions: SlashCommandActions,
) => Promise<SlashSubmitResult>

interface SlashSubcommandDefinition {
  name: string
  description: string
  usage: string
  isVisible: (context: SlashCommandContext) => boolean
  getSuggestions: (parsed: ParsedSlashInput, context: SlashCommandContext) => SlashSuggestion[]
  execute: SlashCommandExecutor
}

interface SlashCommandDefinition {
  name: string
  description: string
  isVisible: (context: SlashCommandContext) => boolean
  subcommands: readonly SlashSubcommandDefinition[]
}

let feedbackSequence = 0

const commandDefinitions: readonly SlashCommandDefinition[] = [
  {
    name: 'xp',
    description: '服务器语音经验',
    isVisible: () => true,
    subcommands: [
      {
        name: 'get',
        description: '查询服务器语音经验',
        usage: '/xp get [@登录名]',
        isVisible: () => true,
        getSuggestions: (parsed, context) => getMemberSuggestions(parsed, context, 'get'),
        execute: (parsed, context, actions) => submitGet(parsed, context, actions),
      },
      {
        name: 'set',
        description: '设置成员服务器语音经验',
        usage: '/xp set @登录名 <xp>',
        isVisible: canUseSet,
        getSuggestions: (parsed, context) => getMemberSuggestions(parsed, context, 'set'),
        execute: (parsed, context, actions) => submitSet(parsed, context, actions),
      },
    ],
  },
]

export function isSlashInput(input: string): boolean {
  return input.trimStart().startsWith('/')
}

export function getSlashSuggestions(input: string, context: SlashCommandContext): SlashSuggestion[] {
  const parsed = parseSlashInput(input)
  if (!parsed) return []

  if (parsed.tokens.length === 1 && !parsed.trailingSpace) {
    return visibleCommands(context)
      .filter((command) => command.name.startsWith(parsed.root))
      .map((command) => ({
        id: command.name,
        label: `/${command.name}`,
        description: command.description,
        value: `/${command.name} `,
      }))
  }

  const command = resolveCommand(parsed, context)
  if (!command) return []

  const subcommandName = parsed.tokens[1]?.toLowerCase() ?? ''
  const visibleSubcommands = command.subcommands.filter((subcommand) => subcommand.isVisible(context))
  if (parsed.tokens.length <= 2 && (
    parsed.trailingSpace || !command.subcommands.some((subcommand) => subcommand.name === subcommandName)
  )) {
    return visibleSubcommands
      .filter((subcommand) => subcommand.name.startsWith(subcommandName))
      .map((subcommand) => ({
        id: `${command.name}-${subcommand.name}`,
        label: `/${command.name} ${subcommand.name}`,
        description: subcommand.description,
        value: `/${command.name} ${subcommand.name} `,
      }))
  }

  const subcommand = resolveSubcommand(command, parsed)
  if (!subcommand) return []
  return subcommand.getSuggestions(parsed, context)
}

export async function submitSlashCommand(
  input: string,
  context: SlashCommandContext,
  actions: SlashCommandActions,
): Promise<SlashSubmitResult> {
  const value = input.trim()
  if (!value.startsWith('/')) return { kind: 'message', content: value }
  if (value.startsWith('//')) return { kind: 'message', content: value.slice(1) }

  const parsed = parseSlashInput(value)
  if (!parsed) return errorResult('未知指令', availableCommands(context))
  if (context.guildId === null || context.currentUser === null) return errorResult('无法执行指令', '当前没有可用的服务器。')

  const command = resolveCommand(parsed, context)
  if (!command) return errorResult('未知指令', availableCommands(context))

  const subcommand = resolveSubcommand(command, parsed)
  if (!subcommand) return errorResult('未知子指令', availableCommands(context))
  return subcommand.execute(parsed, context, actions)
}

function parseSlashInput(input: string): ParsedSlashInput | null {
  const value = input.trimStart()
  if (!value.startsWith('/') || value.startsWith('//')) return null

  const body = value.slice(1)
  const tokens = body.split(/\s+/)
  return {
    value,
    tokens,
    trailingSpace: /\s$/.test(body),
    root: tokens[0]?.toLowerCase() ?? '',
  }
}

function findCommand(name: string): SlashCommandDefinition | undefined {
  return commandDefinitions.find((command) => command.name === name)
}

function resolveCommand(parsed: ParsedSlashInput, context: SlashCommandContext): SlashCommandDefinition | undefined {
  const command = findCommand(parsed.root)
  return command && command.isVisible(context) ? command : undefined
}

function resolveSubcommand(command: SlashCommandDefinition, parsed: ParsedSlashInput): SlashSubcommandDefinition | undefined {
  const name = parsed.tokens[1]?.toLowerCase() ?? ''
  return command.subcommands.find((subcommand) => subcommand.name === name)
}

function visibleCommands(context: SlashCommandContext): SlashCommandDefinition[] {
  return commandDefinitions.filter((command) => command.isVisible(context))
}

function submitGet(
  parsed: ParsedSlashInput,
  context: SlashCommandContext,
  actions: SlashCommandActions,
): Promise<SlashSubmitResult> {
  const tokens = parsed.tokens
  if (tokens.length > 3 || tokens.length < 2) return Promise.resolve(errorResult('参数错误', '用法：/xp get [@登录名]'))
  const target = tokens.length === 2 ? context.currentUser : findTarget(tokens[2], context)
  if (!target) return Promise.resolve(errorResult('找不到成员', '请使用当前服务器中仍活跃的唯一登录名。'))
  return actions.getProfile(target.id, context.guildId!).then((profile): SlashSubmitResult => {
    const progress = profile.voiceProgress
    if (!progress) return errorResult('查询失败', '服务器语音经验暂时不可用。')
    return {
      kind: 'feedback',
      feedback: createFeedback('success', '服务器语音经验', formatGetFeedback(profile.username, progress)),
      clearInput: true,
    }
  }).catch((error) => feedbackFromError(error, '查询失败'))
}

function submitSet(
  parsed: ParsedSlashInput,
  context: SlashCommandContext,
  actions: SlashCommandActions,
): Promise<SlashSubmitResult> {
  const tokens = parsed.tokens
  if (!canUseSet(context)) return Promise.resolve(errorResult('权限不足', '你没有设置服务器语音经验的权限。'))
  if (tokens.length !== 4) return Promise.resolve(errorResult('参数错误', '用法：/xp set @登录名 <xp>'))
  const target = findTarget(tokens[2], context)
  if (!target || !canManageTarget(context, target)) return Promise.resolve(errorResult('找不到成员', '请使用当前服务器中你有权管理的活跃成员登录名。'))
  const rawXP = tokens[3]
  if (!/^[0-9]+$/.test(rawXP)) return Promise.resolve(errorResult('参数错误', 'XP 必须是 0 到 1000000000 的整数。'))
  const xp = Number(rawXP)
  if (!Number.isSafeInteger(xp) || xp < 0 || xp > MAX_VOICE_XP) return Promise.resolve(errorResult('参数错误', 'XP 必须是 0 到 1000000000 的整数。'))
  return actions.setVoiceXP(context.guildId!, target.id, xp).then((result): SlashSubmitResult => ({
    kind: 'feedback',
    feedback: createFeedback('success', '服务器语音经验已设置', formatSetFeedback(result)),
    clearInput: true,
  })).catch((error) => feedbackFromError(error, '设置失败'))
}

function getMemberSuggestions(
  parsed: ParsedSlashInput,
  context: SlashCommandContext,
  subcommand: 'get' | 'set',
): SlashSuggestion[] {
  const expectsTarget = subcommand === 'set' || parsed.tokens.length >= 3
  if (!expectsTarget || parsed.tokens.length > 3) return []
  const typed = parsed.tokens[2] ?? ''
  if (typed && !typed.startsWith('@')) return []
  const query = typed.slice(1).toLocaleLowerCase()
  const candidates = context.members
    .filter((member) => isActiveMember(member))
    .filter((member) => subcommand !== 'set' || canManageTarget(context, member))
    .filter((member) => member.username.toLocaleLowerCase().startsWith(query))
  if (!parsed.trailingSpace && candidates.length === 1 && candidates[0]?.username.toLocaleLowerCase() === query) return []
  const tokenStart = parsed.value.lastIndexOf(typed)
  const prefix = tokenStart >= 0 ? parsed.value.slice(0, tokenStart) : `${parsed.value} `
  return candidates.map((member) => ({
    id: `${subcommand}-member-${member.id}`,
    label: `@${member.username}`,
    description: member.displayName,
    value: `${prefix}@${member.username} `,
  }))
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
  const usages = visibleCommands(context).flatMap((command) => command.subcommands
    .filter((subcommand) => subcommand.isVisible(context))
    .map((subcommand) => subcommand.usage))
  return `可用指令：${usages.join('、')}`
}

function formatGetFeedback(username: string, progress: VoiceProgress): string {
  const earned = progress.xp - progress.levelStartXp
  const needed = Math.max(0, progress.levelEndXp - progress.levelStartXp)
  return `@${username}\n总 XP：${progress.xp}\n等级：Lv.${progress.level}\n当前等级进度：${earned}/${needed}`
}

function formatSetFeedback(result: VoiceXPSetResponse): string {
  return `@${result.target.username}\n修改前：${result.before.xp} XP（Lv.${result.before.level}）\n修改后：${result.after.xp} XP（Lv.${result.after.level}）`
}

function errorResult(title: string, body: string, clearInput = false): SlashSubmitResult {
  return { kind: 'feedback', feedback: createFeedback('error', title, body), clearInput }
}

function feedbackFromError(error: unknown, fallbackTitle: string): SlashSubmitResult {
  const body = error instanceof ApiError && error.message ? error.message : '服务器暂时无法处理该指令。'
  return errorResult(fallbackTitle, body)
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
