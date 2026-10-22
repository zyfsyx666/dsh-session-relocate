/**
 * 核心迁移：预演（A1+A2）、执行（A4 跨盘降级 + 原子发布）、撤销（A5）。
 *
 * 关键保证：任何一步失败都不留「半迁移」状态。
 * 发布顺序 = 备份源 → 在目标父目录内建 .partial 并校验 → rename 原子发布
 *          → 单次原子写注册表（失败自动回滚注册表并删掉新目录）→ 删源。
 */
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { LOG_FILENAME, encodeSegment, projectKey, sessionsRoot, storagesRoot } from './paths.js'
import { inspectLog, rewriteHeaderCwd, verifyLog } from './logfile.js'
import {
  detectOrphans,
  findDefaultWorkspace,
  normalizeKey,
  orderedWorkspaces,
  ownerOf,
  readRegistry,
  realpathNormalize,
  scanSessionDirs,
  writeRegistry,
} from './workspaces.js'
import { recordMigration } from './state.js'

export class MigrationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
  }
}

function backupRoot() {
  return path.join(storagesRoot(), 'dsh-workspace-migration-backup')
}

/** 目标工作区定位：已有（existing）或新建（new）。 */
export async function resolveTarget(target) {
  const registry = await readRegistry()
  if (target?.kind === 'existing') {
    const record = registry.workspaces[target.workspaceId]
    if (!record) throw new MigrationError('workspace/not-found', `工作区不存在：${target.workspaceId}`)
    return { registry, workspaceId: target.workspaceId, record, created: false }
  }
  if (target?.kind === 'new') {
    if (typeof target.path !== 'string' || target.path.trim() === '') {
      throw new MigrationError('workspace/invalid-path', '新建工作区必须提供目录路径')
    }
    const canonical = await realpathNormalize(target.path)
    const folderName = path.basename(canonical)
    let exists = false
    try {
      exists = (await stat(canonical)).isDirectory()
    } catch {
      exists = false
    }
    return {
      registry,
      workspaceId: undefined,
      created: true,
      willCreateDirectory: !exists,
      record: {
        path: canonical,
        title: (target.title || folderName || 'workspace').trim(),
        sessionIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }
  }
  throw new MigrationError('gateway/bad-request', 'target 必须是 {kind:"existing"} 或 {kind:"new"}')
}

/** 预演：不改任何数据。 */
export async function planMigration({ sessionId, target, keepSource = false }) {
  if (!sessionId) throw new MigrationError('gateway/bad-request', '缺少 sessionId')
  const resolved = await resolveTarget(target)
  const { registry } = resolved

  const scanned = await scanSessionDirs()
  const entry = scanned.find((item) => item.sessionId === sessionId)
  if (!entry) throw new MigrationError('session/not-found', `磁盘上找不到会话：${sessionId}`)

  const buf = await readFile(entry.logPath)
  // A1 健康预检：帧边界必须完整、首帧必须是合法 session header
  const inspected = inspectLog(buf)
  const header = inspected.header
  if (!header.cwd) throw new MigrationError('session/no-cwd', `会话 ${sessionId} 的首帧没有 cwd，无法判定归属`)

  const sourceWorkspaceId = ownerOf(registry, sessionId)
  const sourceRecord = sourceWorkspaceId ? registry.workspaces[sourceWorkspaceId] : undefined

  const targetPath = resolved.record.path
  const targetKey = projectKey(targetPath)
  const dirName = encodeSegment(sessionId)
  const nextDir = path.join(sessionsRoot(), targetKey, dirName)
  const nextLog = path.join(nextDir, entry.logFile || LOG_FILENAME)

  // 冲突检查
  let conflict
  try {
    const existing = await stat(nextLog)
    if (existing.isFile()) {
      const same = await readFile(nextLog)
      conflict = same.equals(buf) ? 'identical' : 'different'
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const alreadyThere = normalizeKey(header.cwd) === normalizeKey(targetPath)
  const crossDevice = rootOf(header.cwd) !== rootOf(targetPath)

  return {
    sessionId,
    dirName,
    header,
    frames: inspected.frames,
    bytes: buf.length,
    mtime: entry.mtime,
    sourceWorkspaceId,
    sourcePath: sourceRecord?.path ?? header.cwd,
    sourceLogPath: entry.logPath,
    target: resolved.created
      ? { kind: 'new', path: targetPath, title: resolved.record.title }
      : { kind: 'existing', workspaceId: resolved.workspaceId, path: targetPath, title: resolved.record.title },
    willCreateDirectory: Boolean(resolved.willCreateDirectory),
    targetDir: nextDir,
    targetLogPath: nextLog,
    targetKey,
    crossDevice,
    alreadyThere,
    conflict,
    keepSource,
    warnings: [
      ...(conflict === 'different' ? ['目标位置已存在同名会话目录且内容不同，将拒绝执行'] : []),
      ...(alreadyThere ? ['会话已经在这个工作区，迁移会是空操作'] : []),
      ...(crossDevice ? ['跨设备迁移：会先完整复制并校验，再删除源'] : []),
    ],
  }
}

function rootOf(p) {
  const parsed = path.parse(path.resolve(p))
  return process.platform === 'win32' ? parsed.root.toLowerCase() : parsed.root
}

/**
 * 执行迁移。plan 由 planMigration 产出，且会重新校验一次（防止预演后状态漂移）。
 */
export async function runMigration(plan, { sessionId, target, keepSource = false } = {}) {
  const fresh = await planMigration({ sessionId: sessionId ?? plan.sessionId, target: target ?? plan.target, keepSource })
  if (fresh.alreadyThere) {
    return { ok: true, noop: true, sessionId: fresh.sessionId, target: fresh.target, warnings: ['会话已在目标工作区'] }
  }
  if (fresh.conflict === 'different') {
    throw new MigrationError(
      'workspace/move-invalid',
      `目标位置已存在内容不同的会话目录：${fresh.targetLogPath}。请先确认并清理该目录。`,
    )
  }

  const buf = await readFile(fresh.sourceLogPath)
  verifyLog(buf, { sessionId: fresh.sessionId }) // A1：帧完整
  const rewritten = rewriteHeaderCwd(buf, fresh.target.path)

  // 1) 备份源（撤销用），放在 storages 下，不跨盘
  const backupDir = backupRoot()
  await mkdir(backupDir, { recursive: true })
  const backupPath = path.join(backupDir, `${fresh.dirName}-${Date.now()}.zstd`)
  await copyFile(fresh.sourceLogPath, backupPath)

  // 1b) 新建工作区时先把工作区目录建出来（官方 workspace.create 要求目录已存在）
  if (fresh.target.kind === 'new') await mkdir(fresh.target.path, { recursive: true })

  // 2) 在目标父目录内写 .partial，保证 rename 同盘原子
  const partialDir = `${fresh.targetDir}.partial-${process.pid}`
  await rm(partialDir, { recursive: true, force: true })
  await mkdir(partialDir, { recursive: true })
  const partialLog = path.join(partialDir, path.basename(fresh.targetLogPath))
  await writeFile(partialLog, rewritten)

  // 3) 扇出校验：读回 .partial，确认首帧 cwd/帧数/尾部字节
  const readBack = await readFile(partialLog)
  const checked = verifyLog(readBack, { sessionId: fresh.sessionId, cwd: fresh.target.path })
  if (checked.frames !== fresh.frames) {
    await rm(partialDir, { recursive: true, force: true })
    throw new MigrationError('verify/frame-count', `帧数不一致：源 ${fresh.frames} → 目标 ${checked.frames}`)
  }
  const tailOf = (b) => b.subarray(Math.max(0, b.length - 4096))
  if (!tailOf(buf).equals(tailOf(readBack))) {
    await rm(partialDir, { recursive: true, force: true })
    throw new MigrationError('verify/tail', '日志尾部字节不一致，拒绝发布')
  }

  // 4) 原子发布（同盘 rename；若目标目录已存在且内容相同，先并入）
  await mkdir(path.dirname(fresh.targetDir), { recursive: true })
  if (fresh.conflict === 'identical') await rm(fresh.targetDir, { recursive: true, force: true })
  await rename(partialDir, fresh.targetDir)

  // 5) 单次原子写注册表：先摘源、再挂目标（新工作区则先建记录）
  let workspaceId = fresh.target.workspaceId
  let registryRolledBack = false
  try {
    const registry = await readRegistry()
    const fromId = ownerOf(registry, fresh.sessionId)
    if (fromId && registry.workspaces[fromId]) {
      const rec = registry.workspaces[fromId]
      rec.sessionIds = (rec.sessionIds ?? []).filter((id) => id !== fresh.sessionId)
      rec.updatedAt = new Date().toISOString()
    }
    if (fresh.target.kind === 'new') {
      workspaceId = randomUUID()
      registry.workspaces[workspaceId] = {
        path: fresh.target.path,
        title: fresh.target.title,
        sessionIds: [fresh.sessionId],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      registry.global.workspaceIds.push(workspaceId)
    } else if (registry.workspaces[workspaceId]) {
      const rec = registry.workspaces[workspaceId]
      if (!(rec.sessionIds ?? []).includes(fresh.sessionId)) rec.sessionIds.unshift(fresh.sessionId)
      rec.updatedAt = new Date().toISOString()
    }
    await writeRegistry(registry)
  } catch (error) {
    registryRolledBack = true
    // 注册表没写成：撤掉刚发布的新目录，保持原状
    await rm(fresh.targetDir, { recursive: true, force: true })
    throw new MigrationError('registry/write-failed', `注册表写入失败，已回滚目录：${error?.message ?? error}`)
  }

  // 6) 删源（可保留）；失败不算迁移失败，但如实报告
  let sourceRemoved = false
  let sourceKeptReason
  if (keepSource) {
    sourceKeptReason = 'keepSource=true（保留源，源目录会作为孤儿出现在预检里）'
  } else {
    try {
      await rm(path.dirname(fresh.sourceLogPath), { recursive: true, force: true })
      sourceRemoved = true
    } catch (error) {
      sourceKeptReason = `删除源失败：${error?.message ?? error}`
    }
  }

  const record = await recordMigration({
    sessionId: fresh.sessionId,
    from: { workspaceId: fresh.sourceWorkspaceId, path: fresh.sourcePath },
    to: { workspaceId, path: fresh.target.path, title: fresh.target.title },
    crossDevice: fresh.crossDevice,
    bytes: fresh.bytes,
    frames: fresh.frames,
    backupPath,
    sourceLogPath: fresh.sourceLogPath,
    targetLogPath: fresh.targetLogPath,
    sourceRemoved,
    sourceKeptReason,
    registryRolledBack,
    createdWorkspace: fresh.target.kind === 'new',
  })

  return {
    ok: true,
    sessionId: fresh.sessionId,
    target: { workspaceId, path: fresh.target.path },
    crossDevice: fresh.crossDevice,
    frames: fresh.frames,
    bytes: fresh.bytes,
    sourceRemoved,
    sourceKeptReason,
    backupPath,
    migrationId: record.id,
  }
}

/** 撤销：把会话从备份还原回源位置，并把记账挂回去。 */
export async function undoMigration(migrationId) {
  const { listMigrations, markMigrationUndone } = await import('./state.js')
  const migrations = await listMigrations({ limit: 200 })
  const record = migrations.find((m) => m.id === migrationId)
  if (!record) throw new MigrationError('migration/not-found', `找不到迁移记录：${migrationId}`)
  if (record.undone) throw new MigrationError('migration/already-undone', '这次迁移已经撤销过')

  const backup = await readFile(record.backupPath)
  verifyLog(backup, { sessionId: record.sessionId, cwd: record.from.path })

  // 先用备份重建源目录，再清目标，最后改记账
  const sourceDir = path.dirname(record.sourceLogPath)
  const partialSource = `${sourceDir}.undo-${process.pid}`
  await rm(partialSource, { recursive: true, force: true })
  await mkdir(partialSource, { recursive: true })
  await writeFile(path.join(partialSource, path.basename(record.sourceLogPath)), backup)
  await mkdir(path.dirname(sourceDir), { recursive: true })
  await rm(sourceDir, { recursive: true, force: true })
  await rename(partialSource, sourceDir)

  await rm(path.dirname(record.targetLogPath), { recursive: true, force: true })

  const registry = await readRegistry()
  if (registry.workspaces[record.to.workspaceId]) {
    const rec = registry.workspaces[record.to.workspaceId]
    rec.sessionIds = (rec.sessionIds ?? []).filter((id) => id !== record.sessionId)
    rec.updatedAt = new Date().toISOString()
  }
  if (record.from.workspaceId && registry.workspaces[record.from.workspaceId]) {
    const rec = registry.workspaces[record.from.workspaceId]
    if (!(rec.sessionIds ?? []).includes(record.sessionId)) rec.sessionIds.unshift(record.sessionId)
    rec.updatedAt = new Date().toISOString()
  }
  await writeRegistry(registry)
  await markMigrationUndone(migrationId)

  return { ok: true, sessionId: record.sessionId, restoredTo: record.from.path }
}

/** 把孤儿会话挂回它的 cwd 所属工作区（或指定工作区）。 */
export async function adoptOrphan({ sessionId, workspaceId, dryRun = false }) {
  const registry = await readRegistry()
  const scanned = await scanSessionDirs()
  const orphans = detectOrphans(registry, scanned)
  const orphan = orphans.find((item) => item.sessionId === sessionId)
  if (!orphan) throw new MigrationError('session/not-orphan', `会话 ${sessionId} 不在孤儿列表里`)

  const header = (await import('./logfile.js')).readHeader(await readFile(orphan.logPath))
  const targetId = workspaceId ?? matchWorkspaceByPath(registry, header.cwd)
  if (!targetId) {
    throw new MigrationError('workspace/not-found', `没有工作区对应 cwd=${header.cwd}，请显式指定 workspaceId`)
  }
  if (dryRun) return { ok: true, dryRun: true, sessionId, workspaceId: targetId, cwd: header.cwd }

  const rec = registry.workspaces[targetId]
  if (!(rec.sessionIds ?? []).includes(sessionId)) rec.sessionIds.unshift(sessionId)
  rec.updatedAt = new Date().toISOString()
  await writeRegistry(registry)
  return { ok: true, sessionId, workspaceId: targetId, cwd: header.cwd }
}

/** 找 path 与给定 cwd 相等的工作区。 */
export function matchWorkspaceByPath(registry, cwd) {
  if (!cwd) return undefined
  const key = normalizeKey(cwd)
  for (const [id, record] of Object.entries(registry.workspaces)) {
    if (normalizeKey(record.path) === key) return id
  }
  return undefined
}

export { orderedWorkspaces, findDefaultWorkspace }
