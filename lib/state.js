/**
 * 插件私有状态：迁移历史、批次、排队任务。
 *
 * 存成 <DSH_HOME>/storages/dsh-workspace-migration.json。
 * 刻意不依赖 storageDomain 的 domain API（其表语义未在本版本公开文档中固定），
 * 改用「临时文件 + rename」的原子写 + 进程内串行链，代价是一个文件级竞态窗口，
 * 而这份数据是插件自用的审计记录，可接受。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { storagesRoot } from './paths.js'

const STATE_FILE = 'dsh-workspace-migration.json'
const EMPTY = { version: 1, migrations: [], batches: {}, queue: [] }

let chain = Promise.resolve()

/** 串行化所有状态写入。 */
function serialize(task) {
  const next = chain.then(task, task)
  chain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function statePath() {
  return path.join(storagesRoot(), STATE_FILE)
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { ...EMPTY }
  return {
    version: 1,
    migrations: Array.isArray(raw.migrations) ? raw.migrations : [],
    batches: raw.batches && typeof raw.batches === 'object' ? raw.batches : {},
    queue: Array.isArray(raw.queue) ? raw.queue : [],
  }
}

export async function readState() {
  try {
    const text = await readFile(statePath(), 'utf8')
    return normalize(JSON.parse(text))
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...EMPTY }
    // 状态损坏不应阻断迁移：回退为空态，另存一份坏文件供排查
    try {
      await rename(statePath(), `${statePath()}.corrupt-${Date.now()}`)
    } catch {
      /* ignore */
    }
    return { ...EMPTY }
  }
}

async function writeState(state) {
  const dir = storagesRoot()
  await mkdir(dir, { recursive: true })
  const target = statePath()
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  // Windows 上 rename 不能覆盖既有文件
  await rm(target, { force: true })
  await rename(tmp, target)
}

/** 读-改-写一次。mutator 直接修改传入的 state。 */
export function mutateState(mutator) {
  return serialize(async () => {
    const state = await readState()
    const result = await mutator(state)
    await writeState(state)
    return result
  })
}

// ── 迁移历史 ────────────────────────────────────────────────

export async function recordMigration(entry) {
  const record = {
    id: randomUUID(),
    at: new Date().toISOString(),
    undone: false,
    ...entry,
  }
  await mutateState((state) => {
    state.migrations.unshift(record)
    if (state.migrations.length > 500) state.migrations.length = 500
  })
  return record
}

export async function listMigrations({ limit = 50 } = {}) {
  const state = await readState()
  return state.migrations.slice(0, limit)
}

export async function findLatestMigration(sessionId) {
  const state = await readState()
  return state.migrations.find((m) => m.sessionId === sessionId && !m.undone)
}

export async function markMigrationUndone(migrationId) {
  await mutateState((state) => {
    const found = state.migrations.find((m) => m.id === migrationId)
    if (found) {
      found.undone = true
      found.undoneAt = new Date().toISOString()
    }
  })
}

// ── 批次 ───────────────────────────────────────────────────

export async function createBatch(total) {
  const batch = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    total,
    done: 0,
    failed: 0,
    items: [],
  }
  await mutateState((state) => {
    state.batches[batch.id] = batch
  })
  return batch
}

export async function patchBatch(batchId, patcher) {
  return mutateState((state) => {
    const batch = state.batches[batchId]
    if (!batch) return undefined
    patcher(batch)
    batch.updatedAt = new Date().toISOString()
    return batch
  })
}

export async function getBatch(batchId) {
  const state = await readState()
  return state.batches[batchId]
}

export async function listBatches({ limit = 20 } = {}) {
  const state = await readState()
  return Object.values(state.batches)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit)
}

// ── 排队（零窗口迁移） ─────────────────────────────────────

export async function enqueue(item) {
  const record = { id: randomUUID(), at: new Date().toISOString(), ...item }
  await mutateState((state) => {
    if (!state.queue.some((q) => q.sessionId === item.sessionId)) state.queue.push(record)
  })
  return record
}

export async function dequeue(sessionId) {
  await mutateState((state) => {
    state.queue = state.queue.filter((q) => q.sessionId !== sessionId)
  })
}

export async function listQueue() {
  const state = await readState()
  return state.queue
}
