/**
 * dsh-session-relocate —— DSH 插件入口（Host 半边）
 *
 * 面向 DSH 0.2.1-rc.2 的真实 API：
 *   ctx.connection.rpc.handle(channel, handler)   // handler(endpoint, payload, signal, peer)
 *   ctx.tools.register(toolDefinition)
 *   ctx.get('webServer').register({kind, path, handler})
 *
 * 客户端调用约定（与 client-connection 的 envelope 一致）：
 *   POST <channel>/<endpoint>
 *   { type:'client-request', rpcId, method:<endpoint>, payload:{...} }
 *   -> { type:'server-response', rpcId, result:{ok:true,value} | {ok:false,error:{code,message,details}} }
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MigrationError,
  adoptOrphan,
  matchWorkspaceByPath,
  planMigration,
  runMigration,
  undoMigration,
} from './migrate.js'
import { detectOrphans, findDefaultWorkspace, orderedWorkspaces, readRegistry, scanSessionDirs } from './workspaces.js'
import { listSessions, suggestDirectory, suggestGroups } from './survey.js'
import { defaultWorkspaceParent, dshHome, sessionsRoot, storagesRoot } from './paths.js'
import {
  createBatch,
  dequeue,
  enqueue,
  getBatch,
  listBatches,
  listMigrations,
  listQueue,
  patchBatch,
} from './state.js'

export const name = 'session-relocate'
/**
 * 显式声明依赖服务（cordis 约定：简单字符串数组，服务就绪后才调用 apply）。
 * 空数组会让 apply 在服务尚未挂载时执行，ctx.get('webServer') 拿不到 → 路由静默不注册。
 */
export const inject = ['connection', 'webServer', 'tools', 'approval']
export const CHANNEL = '/session-relocate'
/**
 * 路由布局（webServer 语义：exact 表先查、prefix 表最长匹配）：
 *   GET  /session-relocate          → exact 本插件管理页（HTML）
 *   POST /session-relocate/<endpoint> → prefix 落到 RPC 通道（client-request envelope）
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE_FILE = path.join(HERE, 'ui', 'page.html')

/** 空闲判定：日志 mtime 距今超过该值即认为会话不再写入。 */
const IDLE_MS = 120_000
/** 排队巡检间隔。 */
const QUEUE_TICK_MS = 60_000

let logger = console

function ok(value) {
  return { ok: true, value }
}

function fail(error) {
  const code = error instanceof MigrationError ? error.code : 'internal'
  return { ok: false, error: { code, message: String(error?.message ?? error), details: {} } }
}

// ── 业务端点 ────────────────────────────────────────────────

async function overview() {
  const registry = await readRegistry()
  const workspaces = orderedWorkspaces(registry).map((ws) => ({
    workspaceId: ws.id,
    title: ws.title,
    path: ws.path,
    sessionCount: (ws.sessionIds ?? []).length,
  }))
  const def = findDefaultWorkspace(registry)
  return {
    workspaces,
    defaultWorkspace: def
      ? { workspaceId: def.id, title: def.title, path: def.path, sessionCount: (def.sessionIds ?? []).length }
      : null,
    defaultParent: defaultWorkspaceParent(),
    archivedCount: registry.global.archivedSessionIds.length,
    pinnedCount: registry.global.pinnedSessionIds.length,
  }
}

async function sessions(payload) {
  const { workspaceId, deep } = payload ?? {}
  return listSessions({ workspaceId, deep: Boolean(deep) })
}

async function plan(payload) {
  return planMigration(payload ?? {})
}

async function move(payload) {
  const { sessionId, target, keepSource } = payload ?? {}
  return runMigration(undefined, { sessionId, target, keepSource: Boolean(keepSource) })
}

async function batch(payload) {
  const { sessionIds, target, keepSource, mode } = payload ?? {}
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new MigrationError('gateway/bad-request', 'sessionIds 不能为空')
  }
  const created = await createBatch(sessionIds.length)
  const results = []
  for (const sessionId of sessionIds) {
    try {
      const result = await runMigration(undefined, { sessionId, target, keepSource: Boolean(keepSource) })
      results.push({ sessionId, ok: true, ...result })
      await patchBatch(created.id, (b) => {
        b.done += 1
        b.items.push({ sessionId, status: 'done', at: new Date().toISOString() })
      })
    } catch (error) {
      results.push({ sessionId, ok: false, error: { code: error?.code ?? 'internal', message: String(error?.message ?? error) } })
      await patchBatch(created.id, (b) => {
        b.failed += 1
        b.items.push({
          sessionId,
          status: 'failed',
          error: String(error?.message ?? error),
          at: new Date().toISOString(),
        })
      })
      if (mode === 'abort-on-error') break
    }
  }
  const finished = await patchBatch(created.id, (b) => {
    b.status = b.failed > 0 ? (b.done > 0 ? 'partial' : 'failed') : 'done'
  })
  return { batch: finished, results }
}

async function undo(payload) {
  return undoMigration(payload?.migrationId)
}

async function history() {
  return { migrations: await listMigrations({ limit: 100 }), batches: await listBatches({ limit: 20 }) }
}

async function adopt(payload) {
  return adoptOrphan(payload ?? {})
}

async function groups(payload) {
  const { deep } = payload ?? {}
  const data = await listSessions({ deep: Boolean(deep) })
  const suggestions = suggestGroups(data.rows)
  const parent = defaultWorkspaceParent()
  return {
    suggestions: suggestions.map((group) => ({
      ...group,
      suggestedDirectory: suggestDirectory(parent, group.label),
    })),
    orphanCount: data.orphanCount,
  }
}

async function queue(payload) {
  const action = payload?.action
  if (action === 'list') return { queue: await listQueue() }
  if (action === 'add') {
    const record = await enqueue({ sessionId: payload.sessionId, target: payload.target, keepSource: Boolean(payload.keepSource) })
    return { queued: record, queue: await listQueue() }
  }
  if (action === 'remove') {
    await dequeue(payload.sessionId)
    return { queue: await listQueue() }
  }
  throw new MigrationError('gateway/bad-request', `未知 action：${action}`)
}

async function doctor() {
  const checks = []
  const push = (id, status, detail) => checks.push({ id, status, detail })

  const { accessSync } = await import('node:fs')
  try {
    accessSync(path.dirname(PAGE_FILE))
    push('admin-page', 'pass', PAGE_FILE)
  } catch {
    push('admin-page', 'fail', `管理页缺失：${PAGE_FILE}`)
  }

  try {
    const registry = await readRegistry()
    const def = findDefaultWorkspace(registry)
    push('registry', def ? 'pass' : 'warn', def ? `默认工作区 ${def.title}（${(def.sessionIds ?? []).length} 个会话）` : '未找到默认工作区')
  } catch (error) {
    push('registry', 'fail', String(error?.message ?? error))
  }

  try {
    const scanned = await scanSessionDirs()
    push('sessions-dir', scanned.length > 0 ? 'pass' : 'warn', `${scanned.length} 个会话目录`)
  } catch (error) {
    push('sessions-dir', 'fail', String(error?.message ?? error))
  }

  try {
    const queueItems = await listQueue()
    push('queue', queueItems.length > 0 ? 'warn' : 'pass', `${queueItems.length} 个排队任务`)
  } catch (error) {
    push('queue', 'fail', String(error?.message ?? error))
  }

  return { checks, summary: checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass' }
}

// ── 调度 ───────────────────────────────────────────────────

const ENDPOINTS = {
  overview,
  sessions,
  plan,
  move,
  batch,
  undo,
  history,
  adopt,
  groups,
  queue,
  doctor,
}

/** 需要用户确认的端点（面板会先弹确认；工具侧走 approval 接缝）。 */
const MUTATING = new Set(['move', 'batch', 'undo', 'adopt', 'queue'])

async function dispatch(endpoint, payload, signal, peer) {
  const handler = ENDPOINTS[endpoint]
  if (!handler) return fail(new MigrationError('gateway/not-found', `未知端点：${endpoint}`))
  if (signal?.aborted) return fail(new MigrationError('gateway/cancelled', '请求已取消'))
  try {
    return ok(await handler(payload ?? {}, { signal, peer }))
  } catch (error) {
    logger.warn?.(`[session-relocate] ${endpoint} 失败：${error?.message ?? error}`)
    return fail(error)
  }
}

/** B3：空闲队列巡检 —— 只在日志静止后才动文件。 */
function startQueueWorker(ctx) {
  let stopped = false
  const timer = setInterval(async () => {
    if (stopped) return
    try {
      const items = await listQueue()
      for (const item of items) {
        const scanned = await scanSessionDirs()
        const entry = scanned.find((s) => s.sessionId === item.sessionId)
        if (!entry) continue
        const info = await stat(entry.logPath)
        if (Date.now() - info.mtimeMs < IDLE_MS) continue
        try {
          await runMigration(undefined, { sessionId: item.sessionId, target: item.target, keepSource: item.keepSource })
          await dequeue(item.sessionId)
          logger.info?.(`[session-relocate] 队列迁移完成：${item.sessionId}`)
        } catch (error) {
          logger.warn?.(`[session-relocate] 队列迁移失败 ${item.sessionId}：${error?.message ?? error}`)
        }
      }
    } catch (error) {
      logger.warn?.(`[session-relocate] 队列巡检异常：${error?.message ?? error}`)
    }
  }, QUEUE_TICK_MS)
  timer.unref?.()
  ctx.effect?.(() => () => {
    stopped = true
    clearInterval(timer)
  }, 'session-relocate: queue worker')
}

// ── 工具 ───────────────────────────────────────────────────

const JSON_TEXT = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

async function approveOrThrow(ctx, exec, toolName, reason) {
  const approval = ctx?.approval
  if (!exec?.agent || typeof approval?.request !== 'function') return
  let outcome
  try {
    outcome = await approval.request({ agent: exec.agent, toolName, reason, signal: exec.signal })
  } catch (error) {
    throw new Error(`${toolName} 无法请求审批（${error?.message ?? error}）`)
  }
  if (outcome !== 'allowed-once') {
    throw new Error(`用户未批准本次 ${toolName} 调用（${outcome ?? 'unavailable'}）`)
  }
}

function createTools(ctx) {
  const call = async (endpoint, payload, signal) => {
    const res = await dispatch(endpoint, payload, signal)
    if (!res.ok) throw new Error(`[${res.error.code}] ${res.error.message}`)
    return res.value
  }

  return [
    {
      name: 'migration_overview',
      description:
        '列出 DSH 全部工作区、标出默认工作区（default-workspace）及其会话数。只读。用它把用户口中的工作区名字解析成精确的 workspaceId。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: JSON_TEXT },
      isConcurrencySafe: () => true,
      timeoutMs: 30000,
      async execute(args, exec) {
        return await call('overview', {}, exec?.signal)
      },
    },
    {
      name: 'migration_list_sessions',
      description:
        '列出会话（含标题、首条用户消息、帧数、字节数、是否孤儿）。只读。默认列出全部工作区的会话；传 workspaceId 只看某个工作区。',
      parameters: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: '只列该工作区的会话；省略则列全部' },
          deep: { type: 'boolean', description: '深度扫描全部事件帧（更慢，但标题更准）' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: JSON_TEXT },
      isConcurrencySafe: () => true,
      timeoutMs: 60000,
      async execute(args, exec) {
        return await call('sessions', { workspaceId: args?.workspaceId, deep: Boolean(args?.deep) }, exec?.signal)
      },
    },
    {
      name: 'migration_plan',
      description:
        '迁移预演（dry-run）：不改任何数据，返回源/目标路径、是否跨盘、帧数、字节数、冲突与告警。执行迁移前先调它给用户确认。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          targetWorkspaceId: { type: 'string', description: '迁到已有工作区时给 workspaceId' },
          newWorkspacePath: { type: 'string', description: '迁到新建工作区时给目录绝对路径（目录必须已存在）' },
          newWorkspaceTitle: { type: 'string' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: JSON_TEXT },
      isConcurrencySafe: () => true,
      timeoutMs: 60000,
      async execute(args, exec) {
        return await call('plan', toTargetPayload(args), exec?.signal)
      },
    },
    {
      name: 'migration_move',
      description:
        '把单个会话真正迁移到目标工作区：先做字节级备份，再改写首帧 cwd，在目标父目录内建 .partial 并校验，原子 rename 发布，单次原子写注册表，最后删源（可保留）。失败自动回滚。会请求用户审批。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          targetWorkspaceId: { type: 'string' },
          newWorkspacePath: { type: 'string' },
          newWorkspaceTitle: { type: 'string' },
          keepSource: { type: 'boolean', description: 'true 则保留源目录（会成为孤儿）' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: JSON_TEXT },
      timeoutMs: 180000,
      async execute(args, exec) {
        const payload = toTargetPayload(args)
        await approveOrThrow(
          ctx,
          exec,
          'migration_move',
          `把会话 ${args.sessionId} 迁移到 ${args.targetWorkspaceId ?? args.newWorkspacePath}（会移动磁盘文件，带备份与回滚）`,
        )
        return await call('move', payload, exec?.signal)
      },
    },
    {
      name: 'migration_batch',
      description:
        '批量迁移多个会话到同一目标，返回批次 id 与逐条结果。默认遇到失败继续（mode=continue），可传 abort-on-error 中止。会请求用户审批。',
      parameters: {
        type: 'object',
        properties: {
          sessionIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          targetWorkspaceId: { type: 'string' },
          newWorkspacePath: { type: 'string' },
          newWorkspaceTitle: { type: 'string' },
          keepSource: { type: 'boolean' },
          mode: { type: 'string', enum: ['continue', 'abort-on-error'] },
        },
        required: ['sessionIds'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: JSON_TEXT },
      timeoutMs: 600000,
      async execute(args, exec) {
        await approveOrThrow(ctx, exec, 'migration_batch', `批量迁移 ${args.sessionIds.length} 个会话（移动磁盘文件，逐条备份）`)
        return await call('batch', { ...toTargetPayload(args), sessionIds: args.sessionIds, mode: args.mode }, exec?.signal)
      },
    },
    {
      name: 'migration_history',
      description: '返回迁移历史与批次记录。只读。用它找到 migrationId 以便撤销。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: JSON_TEXT },
      isConcurrencySafe: () => true,
      timeoutMs: 30000,
      async execute(args, exec) {
        return await call('history', {}, exec?.signal)
      },
    },
    {
      name: 'migration_undo',
      description: '撤销一次迁移：从备份还原源目录、清掉目标目录、把记账挂回原工作区。会请求用户审批。',
      parameters: {
        type: 'object',
        properties: { migrationId: { type: 'string' } },
        required: ['migrationId'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: JSON_TEXT },
      timeoutMs: 120000,
      async execute(args, exec) {
        await approveOrThrow(ctx, exec, 'migration_undo', `撤销迁移 ${args.migrationId}（会覆盖源/目标目录）`)
        return await call('undo', { migrationId: args.migrationId }, exec?.signal)
      },
    },
    {
      name: 'migration_orphans',
      description: '列出磁盘上存在但没有任何工作区记账的孤儿会话，并给出能否按 cwd 自动归位。只读。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: JSON_TEXT },
      isConcurrencySafe: () => true,
      timeoutMs: 60000,
      async execute(args, exec) {
        const registry = await readRegistry()
        const scanned = await scanSessionDirs()
        const orphans = detectOrphans(registry, scanned)
        return await call(
          'sessions',
          {},
          exec?.signal,
        ).then((data) => ({
          count: data.orphanCount,
          orphans: data.rows
            .filter((row) => row.orphan)
            .map((row) => ({
              sessionId: row.sessionId,
              cwd: row.profile?.cwd,
              title: row.profile?.title,
              bytes: row.size,
              autoAdoptWorkspaceId: matchWorkspaceByPath(registry, row.profile?.cwd),
            })),
        }))
      },
    },
    {
      name: 'migration_adopt',
      description: '把一个孤儿会话挂回工作区记账（只改记账，不动文件）。会请求用户审批。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          workspaceId: { type: 'string', description: '省略则按会话 cwd 自动匹配' },
          dryRun: { type: 'boolean' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: JSON_TEXT },
      timeoutMs: 60000,
      async execute(args, exec) {
        if (!args?.dryRun) await approveOrThrow(ctx, exec, 'migration_adopt', `把孤儿会话 ${args.sessionId} 挂回工作区记账`)
        return await call('adopt', args, exec?.signal)
      },
    },
    {
      name: 'migration_suggest_groups',
      description: '基于会话标题与首条用户消息做主题聚类，给出可执行的"建议分组"（每组含建议的新工作区目录与成员 sessionId）。只读。',
      parameters: {
        type: 'object',
        properties: { deep: { type: 'boolean' } },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: JSON_TEXT },
      isConcurrencySafe: () => true,
      timeoutMs: 120000,
      async execute(args, exec) {
        return await call('groups', { deep: Boolean(args?.deep) }, exec?.signal)
      },
    },
    {
      name: 'migration_doctor',
      description: '插件自检（只读）：管理页、注册表、会话目录、排队队列状态。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: JSON_TEXT },
      isConcurrencySafe: () => true,
      timeoutMs: 30000,
      async execute(args, exec) {
        return await call('doctor', {}, exec?.signal)
      },
    },
  ]
}

function toTargetPayload(args) {
  const payload = { sessionId: args?.sessionId, keepSource: Boolean(args?.keepSource) }
  if (args?.newWorkspacePath) {
    payload.target = { kind: 'new', path: args.newWorkspacePath, title: args.newWorkspaceTitle }
  } else if (args?.targetWorkspaceId) {
    payload.target = { kind: 'existing', workspaceId: args.targetWorkspaceId }
  } else {
    throw new MigrationError('gateway/bad-request', '必须给 targetWorkspaceId 或 newWorkspacePath')
  }
  return payload
}

/**
 * 统一的 HTTP 处理器（prefix '/session-relocate'）：
 *   GET  /session-relocate           → 管理页
 *   POST /session-relocate/<endpoint> → RPC（DSH 官方 client-request envelope）
 * 自己接管是为了绕开 connection.rpc.handle 的注入守卫缺陷。
 */
async function handleHttp(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const rel = url.pathname.slice(CHANNEL.length) // '' 或 '/overview'

  // 非 POST 一律出管理页（管理页自身用相对路径请求 RPC）
  if (req.method !== 'POST') {
    try {
      const html = await readFile(PAGE_FILE, 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`管理页读取失败：${error?.message ?? error}`)
    }
    return
  }

  // RPC：解析官方 envelope
  let body
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ type: 'server-response', rpcId: 'invalid', result: { ok: false, error: { code: 'gateway/bad-request', message: 'body is not JSON', details: {} } } }))
    return
  }

  const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'unknown'
  // endpoint：优先取 payload 里的显式字段，其次从 URL 末段推导
  const endpoint = (typeof body?.method === 'string' && body.method)
    || rel.replace(/^\//, '')
    || (typeof body?.payload?.endpoint === 'string' ? body.payload.endpoint : '')

  const reply = (result) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
  }

  if (!endpoint) {
    reply({ ok: false, error: { code: 'gateway/bad-request', message: 'missing endpoint', details: {} } })
    return
  }
  reply(await dispatch(endpoint, body?.payload ?? {}, undefined, undefined))
}

// ── 插件装配 ────────────────────────────────────────────────


export function apply(ctx, config) {
  logger = ctx?.logger ?? console
  const services = (key) => ctx?.get?.(key) ?? ctx?.[key]
  const disposers = []
  /** 运行时诊断：最后随 marker 一起落盘，用来回答「register 到底成没成」。 */
  const diag = {}

  // 0) 启动落盘标记：插件一旦被 DSH 加载，这里立刻留下可核对的痕迹。
  //    排查「插件到底加载了没有」时读这个文件即可，不必再猜。
  try {
    const markerDir = path.join(dshHome(), 'logs')
    const markerFile = path.join(markerDir, 'session-relocate-loaded.json')
    diag.markerFile = markerFile
    diag.loadedAt = new Date().toISOString()
    diag.pid = process.pid
    diag.hasConnection = Boolean(services('connection')?.rpc?.handle)
    diag.hasWebServer = Boolean(services('webServer')?.register)
    diag.hasTools = Boolean(services('tools')?.register)
    diag.hasApproval = Boolean(services('approval')?.request)
    mkdirSync(markerDir, { recursive: true })
    logger.info?.(`[session-relocate] 已加载 pid=${process.pid} connection=${diag.hasConnection} webServer=${diag.hasWebServer} tools=${diag.hasTools}`)
  } catch (error) {
    logger.warn?.(`[session-relocate] 启动标记初始化失败：${error?.message ?? error}`)
  }
  /** 把 diag 写到 marker（apply 结束时调用，保证包含 register 结果）。 */
  const flushDiag = () => {
    try {
      if (diag.markerFile) writeFileSync(diag.markerFile, JSON.stringify(diag, null, 2))
    } catch (error) {
      logger.warn?.(`[session-relocate] 诊断落盘失败：${error?.message ?? error}`)
    }
  }

  // 1)+2) 管理页 + RPC：只用一个 webServer prefix 路由。
  //
  // 为什么不使用 connection.rpc.handle（DSH 0.2.1-rc.2 实测）：
  //   connection.rpc.handle 内部执行 owner.effect(() => owner.webServer.register(...))，
  //   而 owner 是 connection 服务自身的 fiber ctx，它并未 inject 'webServer'，
  //   于是 cordis 注入守卫抛出 "cannot get property \"webServer\" without inject"。
  //   这与调用方怎么写无关 —— 即使把 handle 放进 ctx.inject 回调也一样崩。
  //
  // 因此这里直接接管 HTTP：prefix '/session-relocate' 一个路由，
  //   GET  /session-relocate            → 管理页 HTML
  //   POST /session-relocate/<endpoint> → 自己解析 client-request envelope 后分发
  // 协议保持与 DSH 官方一致，前端代码无需改动。
  const mount = (webCtx) => {
    diag.mountEnteredAt = new Date().toISOString()
    const webServer = webCtx.get('webServer')
    diag.webServerType = typeof webServer
    diag.hasRegister = typeof webServer?.register === 'function'
    if (!webServer?.register) {
      diag.routeError = 'webServer.register 不可用'
      flushDiag()
      return
    }
    try {
      const dispose = webServer.register({
        kind: 'prefix',
        path: CHANNEL,
        handler: async (req, res) => handleHttp(req, res),
      })
      disposers.push(dispose)
      diag.routeRegistered = true
      diag.routeKind = 'prefix'
      logger.info?.(`[session-relocate] 管理页 + RPC 已挂载：${CHANNEL}`)
    } catch (error) {
      diag.routeError = String(error?.message ?? error)
      logger.warn?.(`[session-relocate] 挂载失败：${error?.message ?? error}`)
    }
    diag.mountCompletedAt = new Date().toISOString()
    flushDiag()
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mount)
  } else {
    try {
      mount(ctx)
    } catch (error) {
      diag.injectFallbackError = String(error?.message ?? error)
      flushDiag()
    }
  }

  // 3) agent 工具
  const tools = services('tools')
  diag.toolsRegistered = 0
  if (tools?.register) {
    for (const tool of createTools(ctx)) {
      tools.register(tool)
      diag.toolsRegistered += 1
    }
    logger.info?.('[session-relocate] agent 工具已注册')
  }

  // 4) 空闲队列巡检（B3）
  startQueueWorker(ctx)

  // 5) 统一清理：插件卸载/热重载时释放路由
  ctx.effect?.(
    () => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.()
        } catch {
          /* ignore */
        }
      }
    },
    'session-relocate: routes',
  )

  // 6) 落盘诊断结果（含 register 成败），供重启后直接读取
  diag.applyCompletedAt = new Date().toISOString()
  flushDiag()

  void MUTATING
  void config
}

export { dispatch, overview, sessions, plan, move, batch, undo, history, adopt, groups, queue, doctor }
