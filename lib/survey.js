/**
 * 会话画像与列表（A2 预演的数据源、B2 智能分组的输入）。
 *
 * 事件帧格式（实测）：{type, seq, time, data}
 *   session/title        → data.title / data.source.kind（fallback|provider）
 *   user/message         → data.content[0].text，data.source.kind==='user' 才是真人输入
 *   assistant/message    → 助手回复
 *   turn/start, turn/end → 轮次
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { readHeader, zstdFrames } from './logfile.js'
import { detectOrphans, detectMissing, readRegistry, scanSessionDirs } from './workspaces.js'

/** 只解前 N 帧做浅扫描（标题与首条用户消息都在会话早期）。 */
const SHALLOW_FRAMES = 40

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 扫描一个日志文件，抽取画像。deep=false 只看前若干帧。 */
export function profileLog(buf, { deep = false, maxFrames = SHALLOW_FRAMES } = {}) {
  const header = readHeader(buf)
  let frames = 0
  let title
  let titleSource
  let firstUserText = ''
  let lastTime = 0
  let turns = 0
  let assistantCount = 0
  let userCount = 0
  let corrupt = false

  for (const [start, end] of zstdFrames(buf)) {
    frames += 1
    if (!deep && frames > maxFrames) break
    let text
    try {
      text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      corrupt = true
      break
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        corrupt = true
        continue
      }
      if (typeof event.time === 'number' && event.time > lastTime) lastTime = event.time
      switch (event.type) {
        case 'session/title': {
          if (typeof event.data?.title === 'string' && event.data.title.trim()) {
            title = event.data.title.trim()
            titleSource = event.data?.source?.kind
          }
          break
        }
        case 'user/message': {
          userCount += 1
          if (!firstUserText && event.data?.source?.kind === 'user') {
            firstUserText = textOf(event.data.content).slice(0, 160)
          }
          break
        }
        case 'assistant/message': {
          assistantCount += 1
          break
        }
        case 'turn/start': {
          turns += 1
          break
        }
        default:
          break
      }
    }
  }

  return {
    sessionId: header.id,
    cwd: header.cwd,
    createdAt: header.createdAt,
    agentPreset: header.agentPreset,
    frames,
    title,
    titleSource,
    firstUserText,
    lastTime,
    turns,
    assistantCount,
    userCount,
    corrupt,
    bytes: buf.length,
  }
}

/** 列表：某个工作区（或全部）的会话 + 孤儿。 */
export async function listSessions({ workspaceId, deep = false, includeOrphans = true } = {}) {
  const registry = await readRegistry()
  const scanned = await scanSessionDirs()
  const orphans = detectOrphans(registry, scanned)
  const missing = detectMissing(registry, scanned)
  const orphanSet = new Set(orphans.map((item) => item.sessionId))

  const bySession = new Map(scanned.map((item) => [item.sessionId, item]))
  const rows = []

  for (const [id, record] of Object.entries(registry.workspaces)) {
    if (workspaceId && id !== workspaceId) continue
    for (const sessionId of record.sessionIds ?? []) {
      const entry = bySession.get(sessionId)
      if (!entry) continue // 缺失的单独统计
      let profile
      try {
        profile = profileLog(await readFile(entry.logPath), { deep })
      } catch (error) {
        profile = { sessionId, corrupt: true, error: String(error?.message ?? error), frames: 0, bytes: 0 }
      }
      rows.push({ workspaceId: id, workspacePath: record.path, dirName: entry.dirName, ...entry, profile })
    }
  }

  if (includeOrphans && !workspaceId) {
    for (const entry of orphans) {
      let profile
      try {
        profile = profileLog(await readFile(entry.logPath), { deep })
      } catch (error) {
        profile = { sessionId: entry.sessionId, corrupt: true, error: String(error?.message ?? error), frames: 0, bytes: 0 }
      }
      rows.push({ workspaceId: undefined, workspacePath: profile.cwd, dirName: entry.dirName, ...entry, profile, orphan: true })
    }
  }

  return {
    rows,
    orphanCount: orphans.length,
    missingCount: missing.length,
    missing,
    orphanIds: [...orphanSet],
  }
}

// ── B2：分组建议 ──────────────────────────────────────────

const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说',
  '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', 'the', 'a', 'an', 'to', 'of', 'and',
  'for', 'in', 'is', 'it', 'this', 'that', 'with', 'help', 'please', 'can', 'you', 'me', 'my', 'how', 'what',
])

function tokens(text) {
  if (!text) return new Set()
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const out = new Set()
  for (const word of cleaned.split(/\s+/)) {
    if (word.length < 2 || STOPWORDS.has(word)) continue
    out.add(word)
  }
  // 中文无空格：额外喂 2-gram
  for (const chunk of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= chunk.length; i++) {
      const gram = chunk.slice(i, i + 2)
      if (!STOPWORDS.has(gram)) out.add(gram)
    }
  }
  return out
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const item of a) if (b.has(item)) inter += 1
  return inter / (a.size + b.size - inter)
}

function dayKey(ms) {
  if (!ms) return 'unknown'
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 生成可执行的"建议分组"：
 *  1. 主题聚类（title + 首条用户消息的 2-gram Jaccard ≥ 阈值）
 *  2. 批内低于阈值时退化为按天窗口分组
 * 每组给出建议的新工作区目录名与成员会话。
 */
export function suggestGroups(rows, { threshold = 0.12, minSize = 2 } = {}) {
  const items = rows.map((row) => ({
    sessionId: row.sessionId,
    title: row.profile?.title ?? '',
    sample: row.profile?.firstUserText ?? '',
    createdAt: row.profile?.createdAt ?? row.mtime ?? 0,
    tokens: tokens(`${row.profile?.title ?? ''} ${row.profile?.firstUserText ?? ''}`),
  }))

  // 并查集聚类
  const parent = items.map((_, index) => index)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (jaccard(items[i].tokens, items[j].tokens) >= threshold) union(i, j)
    }
  }
  const buckets = new Map()
  items.forEach((item, index) => {
    const root = find(index)
    if (!buckets.has(root)) buckets.set(root, [])
    buckets.get(root).push(item)
  })

  const groups = []
  for (const members of buckets.values()) {
    if (members.length < minSize) continue
    const label = members
      .map((m) => m.title || m.sample.slice(0, 24))
      .filter(Boolean)
      .slice(0, 3)
      .join(' / ')
    groups.push({
      kind: 'topic',
      label: label || '未命名分组',
      size: members.length,
      sessionIds: members.map((m) => m.sessionId),
    })
  }

  // 按天补充"时间档案"分组（抓主题聚类漏掉的）
  const claimed = new Set(groups.flatMap((g) => g.sessionIds))
  const byDay = new Map()
  for (const item of items) {
    if (claimed.has(item.sessionId)) continue
    const key = dayKey(item.createdAt)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(item)
  }
  for (const [day, members] of byDay) {
    if (members.length < minSize) continue
    groups.push({
      kind: 'day',
      label: `归档 ${day}`,
      size: members.length,
      sessionIds: members.map((m) => m.sessionId),
    })
  }

  return groups.sort((a, b) => b.size - a.size)
}

/** 建议分组 → 建议的目录（在默认工作区同级）。 */
export function suggestDirectory(baseParent, label) {
  const safe = label
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  return path.join(baseParent, `archive-${safe || 'group'}`)
}
