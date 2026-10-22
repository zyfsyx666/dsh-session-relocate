/**
 * 工作区注册表（<DSH_HOME>/storages/workspace.json）与会话目录的读写。
 *
 * 注册表格式（实测 v2）：
 * { unit:{name:'workspace',version:2},
 *   global:{initialized, defaultWorkspaceId?, workspaceIds[], archivedSessionIds[], pinnedSessionIds[]},
 *   tables:{ workspaces:{ [id]:{path,title,sessionIds[],createdAt,updatedAt} } } }
 */
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LOG_FILENAME, sessionsRoot, storagesRoot } from './paths.js'

const REGISTRY_FILE = 'workspace.json'

export function registryPath() {
  return path.join(storagesRoot(), REGISTRY_FILE)
}

/** Windows 上路径比较大小写不敏感。 */
export function normalizeKey(p) {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export async function realpathNormalize(p) {
  try {
    return await realpath(path.resolve(p))
  } catch {
    return path.resolve(p)
  }
}

export async function readRegistry() {
  const text = await readFile(registryPath(), 'utf8')
  const raw = JSON.parse(text)
  const workspaces = raw?.tables?.workspaces ?? {}
  const global = raw?.global ?? {}
  return {
    raw,
    unit: raw?.unit ?? { name: 'workspace', version: 2 },
    global: {
      initialized: global.initialized !== false,
      defaultWorkspaceId: global.defaultWorkspaceId,
      workspaceIds: Array.isArray(global.workspaceIds) ? global.workspaceIds : [],
      archivedSessionIds: Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : [],
      pinnedSessionIds: Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : [],
    },
    workspaces,
  }
}

/** 原子写注册表；写前把原文件备份成 .bak-<ts>。 */
export async function writeRegistry(registry) {
  const target = registryPath()
  await mkdir(path.dirname(target), { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  try {
    await copyFile(target, `${target}.bak-${stamp}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const payload = {
    unit: registry.unit,
    global: registry.global,
    tables: { workspaces: registry.workspaces },
  }
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rm(target, { force: true })
  await rename(tmp, target)
}

/** 有序工作区列表（按 global.workspaceIds 顺序）。 */
export function orderedWorkspaces(registry) {
  const seen = new Set()
  const out = []
  for (const id of registry.global.workspaceIds) {
    const record = registry.workspaces[id]
    if (record) {
      out.push({ id, ...record })
      seen.add(id)
    }
  }
  for (const [id, record] of Object.entries(registry.workspaces)) {
    if (!seen.has(id)) out.push({ id, ...record })
  }
  return out
}

/** 默认工作区（凭 global.defaultWorkspaceId 定位；没有再退化为名为 default-workspace 的记录）。 */
export function findDefaultWorkspace(registry) {
  const byId = registry.global.defaultWorkspaceId
  if (byId && registry.workspaces[byId]) return { id: byId, ...registry.workspaces[byId] }
  for (const [id, record] of Object.entries(registry.workspaces)) {
    if (path.basename(record.path).toLowerCase() === 'default-workspace') return { id, ...record }
  }
  return undefined
}

/** 会话 id -> 宿主工作区 id（含已归档会话）。 */
export function ownerOf(registry, sessionId) {
  for (const [id, record] of Object.entries(registry.workspaces)) {
    if ((record.sessionIds ?? []).includes(sessionId)) return id
  }
  return undefined
}

/** 扫描 <sessions>/<dirKey>/<sessionDir>/session.v*.jsonl.zstd，不解析内容。 */
export async function scanSessionDirs(root = sessionsRoot()) {
  const out = []
  let projectDirs
  try {
    projectDirs = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return out
    throw error
  }
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue
    const projectPath = path.join(root, projectDir.name)
    let sessionDirs
    try {
      sessionDirs = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue
      const dir = path.join(projectPath, sessionDir.name)
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      const log = entries.find((e) => e.isFile() && /^session(\.v\d+)?\.jsonl\.zstd$/.test(e.name))
      if (!log) continue
      const logPath = path.join(dir, log.name)
      let size = 0
      let mtime = 0
      try {
        const info = await stat(logPath)
        size = info.size
        mtime = info.mtimeMs
      } catch {
        /* ignore */
      }
      out.push({
        dirKey: projectDir.name,
        dirName: sessionDir.name,
        dir,
        logPath,
        logFile: log.name,
        size,
        mtime,
        sessionId: sessionDir.name,
      })
    }
  }
  return out
}

/** 读日志首帧 header（只解压第一帧）。 */
export async function readSessionHeader(logPath) {
  const { readHeader } = await import('./logfile.js')
  const buf = await readFile(logPath)
  return readHeader(buf)
}

/** 磁盘上有、注册表里没有任何工作区记账的会话。 */
export function detectOrphans(registry, scanned) {
  const owned = new Set()
  for (const record of Object.values(registry.workspaces)) {
    for (const id of record.sessionIds ?? []) owned.add(id)
  }
  return scanned.filter((entry) => !owned.has(entry.sessionId))
}

/** 注册表记账里存在、磁盘上找不到日志的会话。 */
export function detectMissing(registry, scanned) {
  const onDisk = new Set(scanned.map((entry) => entry.sessionId))
  const out = []
  for (const [workspaceId, record] of Object.entries(registry.workspaces)) {
    for (const id of record.sessionIds ?? []) {
      if (!onDisk.has(id)) out.push({ workspaceId, sessionId: id })
    }
  }
  return out
}

export { LOG_FILENAME }
