/**
 * 工作区助理的「上下文供给」（高速缓存 + 持久化快照版）。
 *
 * 优化点：
 *   1. 单次读取 + mtime/size 文件级增量缓存，避免每次全量重复 JSON.parse。
 *   2. 持久化轻量快照（<DSH_HOME>/workspace-assistant/context-snapshot.json）：
 *      冷启动时 1ms 内同步加载上一次快照，确保首轮对话立即可用，后台再异步增量刷新。
 *   3. 注入格式分层高密度化：头部全局统计 + 按活跃度排序的工作区与会话状态标签。
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'workspace-assistant-context'

export const inject = ['systemPrompt']

const SECTION_NAME = 'workspace-assistant:workspace-summary'
const CONTEXT_ORDER = 125
const CACHE_TTL_MS = 20 * 1000
const MAX_WORKSPACES = 10
const MAX_SESSIONS_PER_WORKSPACE = 6
const CLIP = 80
const PROJ_CACHE_LIMIT = 500

const PROJECTION_PARTS = ['storages', 'session_projcache', 'sessions']
const FILE_CACHE = new Map()

function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env !== '') return env
  return join(homedir(), '.dsh')
}

function snapshotFile() {
  return join(dshHome(), 'workspace-assistant', 'context-snapshot.json')
}

function clip(value, max) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function shortSessionId(id) {
  const raw = String(id === undefined || id === null ? '' : id)
  const stripped = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  return stripped.slice(0, 8)
}

function statusOf(values) {
  const approval = asObject(values.approvalState) || {}
  const boundary = asObject(values.turnBoundary) || {}
  const questions = asObject(values.userQuestions) || {}
  const active = asArray(asObject(questions.questions) ? questions.questions.active : null)
  const stats = asObject(values.sessionStats) || {}
  const meta = asObject(values.sessionListMetadata) || {}

  if (active.length > 0) {
    const first = asObject(active[0]) || {}
    return { key: 'waiting', tag: '待你回答', label: '在等你回答', pending: clip(first.question || first.header || '', CLIP) }
  }
  if (boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined) return { key: 'running', tag: '运行中', label: '正在跑' }
  if (approval.turnOpen === true) return { key: 'running', tag: '运行中', label: '正在跑' }
  if (meta.blank === true) return { key: 'blank', tag: '空白', label: '空白会话' }
  if (stats.turns === 0) return { key: 'blank', tag: '空白', label: '还没开始' }
  if (asArray(stats.pendingCalls).length > 0) return { key: 'running', tag: '运行中', label: '工具还没回来' }
  return { key: 'idle', tag: '空闲', label: '空闲' }
}

function lastTool(values) {
  const activity = asObject(values.contextActivity) || {}
  const days = asObject(activity.days) || {}
  const dates = Object.keys(days).sort()
  if (dates.length === 0) return ''
  const dayObj = asObject(days[dates[dates.length - 1]])
  const tools = asObject(dayObj ? dayObj.tools : null) || {}
  let best = ''
  let bestAt = -1
  for (const toolName of Object.keys(tools)) {
    const entry = asObject(tools[toolName]) || {}
    const at = typeof entry.last === 'number' ? entry.last : 0
    if (at > bestAt) { bestAt = at; best = toolName }
  }
  return best
}

function activityAt(values, fallback) {
  const meta = asObject(values.sessionListMetadata) || {}
  const cost = asObject(values.costUsage) || {}
  const step = asObject(cost.stepStart) || {}
  const candidates = [meta.lastPromptAt, step.at, fallback]
  for (const candidate of candidates) if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  return 0
}

/** 单次读取 + mtime/size 缓存，返回 { summary, cwd } */
function readEntryCached(dir, file) {
  const fullPath = join(dir, file)
  let stat
  try {
    stat = statSync(fullPath)
    if (!stat.isFile()) return null
  } catch {
    return null
  }

  const cached = FILE_CACHE.get(file)
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entry
  }

  let entry = null
  try {
    const parsed = JSON.parse(readFileSync(fullPath, 'utf8'))
    const rows = parsed && parsed.record && parsed.record.rows ? parsed.record.rows : null
    if (rows !== null) {
      const values = {}
      for (const key of Object.keys(rows)) {
        const row = rows[key]
        if (row !== null && typeof row === 'object' && 'val' in row) values[key] = row.val
      }
      const identity = parsed.record.identity !== null && typeof parsed.record.identity === 'object' ? parsed.record.identity : {}
      const base = file.slice(0, -'.json'.length)
      const sessionId = base.startsWith('session-') ? base : 'session-' + base
      const title = typeof values.title === 'string' ? values.title : ''
      const outline = asObject(values.turnOutline) || {}
      const turns = asArray(outline.turns)
      const lastTurn = turns.length > 0 ? asObject(turns[turns.length - 1]) || {} : {}
      const status = statusOf(values)
      const createdAt = typeof identity.createdAt === 'number' ? identity.createdAt : 0
      const tool = lastTool(values)
      const cwd = typeof identity.cwd === 'string' && identity.cwd !== '' ? identity.cwd : '(未知目录)'

      entry = {
        cwd,
        summary: {
          id: sessionId,
          shortId: shortSessionId(sessionId),
          title: clip(title, CLIP),
          asked: clip(lastTurn.prompt, CLIP),
          said: clip(lastTurn.response, CLIP),
          status,
          tool: clip(tool, 24),
          updatedAt: activityAt(values, createdAt),
        },
      }
    }
  } catch {
    entry = null
  }

  FILE_CACHE.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entry })
  if (FILE_CACHE.size > PROJ_CACHE_LIMIT) {
    const oldest = FILE_CACHE.keys().next()
    if (oldest.done !== true) FILE_CACHE.delete(oldest.value)
  }
  return entry
}

function formatTime(at) {
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return date.getFullYear() + '/' + pad(date.getMonth() + 1) + '/' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/** 把投影目录折成一段高密度分层纯文本 */
function buildSummary() {
  const dir = join(dshHome(), ...PROJECTION_PARTS)
  let files = []
  try {
    files = readdirSync(dir).filter((entry) => entry.endsWith('.json'))
  } catch {
    return ''
  }

  const byWorkspace = new Map()
  let totalSessions = 0
  let totalRunning = 0
  let totalWaiting = 0

  for (const file of files) {
    const item = readEntryCached(dir, file)
    if (item === null) continue
    totalSessions += 1
    if (item.summary.status.key === 'running') totalRunning += 1
    else if (item.summary.status.key === 'waiting') totalWaiting += 1

    const key = item.cwd.toLowerCase()
    if (!byWorkspace.has(key)) byWorkspace.set(key, { cwd: item.cwd, sessions: [] })
    byWorkspace.get(key).sessions.push(item.summary)
  }

  if (byWorkspace.size === 0) return ''

  const groups = [...byWorkspace.values()]
  for (const group of groups) group.sessions.sort((left, right) => right.updatedAt - left.updatedAt)
  groups.sort((left, right) => {
    const leftAt = left.sessions.length > 0 ? left.sessions[0].updatedAt : 0
    const rightAt = right.sessions.length > 0 ? right.sessions[0].updatedAt : 0
    return rightAt - leftAt
  })

  const lines = [
    '【本机工作区实时快照 · Active Memory】',
    `共 ${groups.length} 个工作区 / ${totalSessions} 个会话（运行中 ${totalRunning} · 待你回答 ${totalWaiting}）。`,
    '请直接基于本快照回答进展、优先级与会话状态；仅在需要读具体代码或磁盘文件时再派 subagent 或用工具。',
    '',
  ]

  let budget = 4600
  for (const group of groups.slice(0, MAX_WORKSPACES)) {
    const head = `## ${group.cwd}（${group.sessions.length} 个会话）`
    if (budget - head.length < 200) break
    lines.push(head)
    budget -= head.length
    for (const session of group.sessions.slice(0, MAX_SESSIONS_PER_WORKSPACE)) {
      const bits = [`- [${session.status.tag}] #${session.shortId}「${session.title || '未命名'}」`]
      if (session.status.pending) bits.push('待你回答：' + session.status.pending)
      if (session.tool) bits.push('工具：' + session.tool)
      if (session.asked) bits.push('问：' + session.asked)
      if (session.said) bits.push('答：' + session.said)
      const when = formatTime(session.updatedAt)
      if (when !== '') bits.push(when)
      const line = bits.join(' | ')
      if (budget - line.length < 0) break
      lines.push(line)
      budget -= line.length
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

function loadPersistedSnapshot() {
  try {
    const parsed = JSON.parse(readFileSync(snapshotFile(), 'utf8'))
    if (parsed && typeof parsed.text === 'string' && parsed.text !== '') {
      return { text: parsed.text, at: typeof parsed.at === 'number' ? parsed.at : 0 }
    }
  } catch {
    // 首次无持久化快照
  }
  return null
}

function persistSnapshot(text, at) {
  try {
    mkdirSync(join(dshHome(), 'workspace-assistant'), { recursive: true })
    writeFileSync(snapshotFile(), JSON.stringify({ at, text }), 'utf8')
  } catch {
    // 落盘失败不影响运行
  }
}

export function apply(ctx) {
  const initial = loadPersistedSnapshot()
  let cached = initial !== null ? initial.text : ''
  let cachedAt = initial !== null ? initial.at : 0
  let building = false

  const refresh = function () {
    if (building) return
    building = true
    setTimeout(() => {
      try {
        const next = buildSummary()
        if (next !== '') {
          const now = Date.now()
          cached = next
          cachedAt = now
          persistSnapshot(next, now)
        }
      } catch {
        // 快照失败就继续用上一份
      } finally {
        building = false
      }
    }, 0)
  }

  const current = function () {
    if (cached === '') {
      const next = buildSummary()
      if (next !== '') {
        cached = next
        cachedAt = Date.now()
        persistSnapshot(next, cachedAt)
      }
      return cached
    }
    if (Date.now() - cachedAt > CACHE_TTL_MS) refresh()
    return cached
  }

  refresh()

  ctx.effect(() => ctx.systemPrompt.context({
    name: SECTION_NAME,
    order: CONTEXT_ORDER,
    text: () => current(),
  }), 'workspace-assistant-context.section()')
}
