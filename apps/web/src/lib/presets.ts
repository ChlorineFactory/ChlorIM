import type { CreateBotRequest, DriverName, PresenceStatus } from '@chiorim/shared'

export type AvatarPreset = {
  id: string
  label: string
  glyph: string
  bg: string
}

export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: 'preset:codex', label: 'Codex', glyph: 'CX', bg: '#1e2b24' },
  { id: 'preset:claude', label: 'Claude', glyph: 'CL', bg: '#2e241b' },
  { id: 'preset:agy', label: 'Antigravity', glyph: 'AG', bg: '#1d2430' },
  { id: 'preset:hermes', label: 'Hermes', glyph: 'HM', bg: '#1c282e' },
  { id: 'preset:spark', label: '助手', glyph: 'AI', bg: '#26262b' },
  { id: 'preset:code', label: '开发', glyph: '</>', bg: '#20262b' },
  { id: 'preset:fox', label: '暖棕', glyph: 'F', bg: '#3b261d' },
  { id: 'preset:cat', label: '梅红', glyph: 'M', bg: '#36202a' },
  { id: 'preset:owl', label: '石板', glyph: 'O', bg: '#292d35' },
  { id: 'preset:rocket', label: '砖红', glyph: 'R', bg: '#382121' },
  { id: 'preset:leaf', label: '松绿', glyph: 'L', bg: '#1e2f26' },
  { id: 'preset:wave', label: '海蓝', glyph: 'W', bg: '#1d2a3a' },
]

export const presetById = (url?: string | null) =>
  url ? AVATAR_PRESETS.find(item => item.id === url) : undefined

export const QUICK_EMOJIS = ['👍', '👀', '✅', '❤️', '😂', '🔥', '🎉', '🚀']

export const PRESENCE_META: Record<PresenceStatus, { label: string; color: string }> = {
  online: { label: '在线', color: 'var(--online)' },
  busy: { label: '忙碌', color: 'var(--busy)' },
  away: { label: '离开', color: 'var(--away)' },
}

export type BotTemplate = {
  id: string
  label: string
  hint: string
  mode: CreateBotRequest['mode']
  display_name: string
  username: string
  avatar_url: string
  bio: string
  driver_hint?: DriverName
  system_prompt?: string
}

export const BOT_TEMPLATES: BotTemplate[] = [
  {
    id: 'codex',
    label: 'Codex',
    hint: '本机直连 · 免 Bridge',
    mode: 'local',
    display_name: 'Codex',
    username: 'codex',
    avatar_url: 'preset:codex',
    bio: '本机 Codex CLI',
    driver_hint: 'codex',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    hint: '本机直连 · 免 Bridge',
    mode: 'local',
    display_name: 'Claude Code',
    username: 'claude_code',
    avatar_url: 'preset:claude',
    bio: '本机 Claude Code',
    driver_hint: 'claude-code',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    hint: '本机直连 · agy CLI',
    mode: 'local',
    display_name: 'Antigravity',
    username: 'agy',
    avatar_url: 'preset:agy',
    bio: '本机 agy CLI',
    driver_hint: 'antigravity',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    hint: 'Hermes 插件 / Bridge',
    mode: 'bridge',
    display_name: 'Hermes',
    username: 'hermes',
    avatar_url: 'preset:hermes',
    bio: 'Hermes Gateway 原生适配',
    driver_hint: 'hermes',
  },
  {
    id: 'reviewer',
    label: '代码评审',
    hint: 'Provider 模型',
    mode: 'provider',
    display_name: 'Reviewer',
    username: 'reviewer',
    avatar_url: 'preset:code',
    bio: '代码审查与排查',
    system_prompt: '你是务实的代码审查助手。直接指出问题根因并给出简洁修复建议。',
  },
  {
    id: 'general-ai',
    label: '通用模型',
    hint: 'Provider 模型',
    mode: 'provider',
    display_name: 'Assistant',
    username: 'assistant',
    avatar_url: 'preset:spark',
    bio: '日常问答',
    system_prompt: '回答简洁、准确、直接。',
  },
]

export type SlashCommandItem = {
  name: string
  usage: string
  description: string
  insert: string
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  { name: '/reset', usage: '/reset [@bot]', description: '清除当前频道/Thread 的 Bot 会话', insert: '/reset ' },
  { name: '/model', usage: '/model @bot <model>', description: '切换模型 Bot 的模型', insert: '/model @' },
  { name: '/ask', usage: '/ask @bot1 @bot2 <问题>', description: '同时向多个 Bot 提问', insert: '/ask @' },
  { name: '/status', usage: '/status', description: '查看频道内 Bot 状态', insert: '/status' },
]

export function summarizeUserAgent(ua: string) {
  if (!ua) return '未知设备'
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : /curl|node|undici/i.test(ua) ? 'API / CLI'
    : '浏览器'
  const os = /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : ''
  return os ? `${browser} · ${os}` : browser
}
