# dsh-session-relocate

在 DSH（DeepSeek Harness）里**安全迁移会话**：把 `default-workspace` 里堆积的对话，批量搬到已有工作区或新建工作区。真迁移——保持 session id 与完整历史，只改写首帧 `cwd`；迁移前做字节级备份，失败自动回滚，支持一键撤销。

> 兼容：DSH `0.2.1-rc.2`（实测验证，见下方「DSH 集成要点」）；Node ≥ 22（依赖 `node:zlib` 的 zstd）。

## 功能

| 功能 | 说明 |
|---|---|
| A1 健康预检 | 迁移前逐帧校验 zstd 日志完整性，损坏会话直接拒绝，绝不"带病搬运" |
| A2 迁移预演 | dry-run 报告：源/目标路径、是否跨盘、帧数、字节数、冲突、告警，不动任何数据 |
| A3 批量迁移 | 批次状态机（done/partial/failed），逐条隔离失败，支持 continue / abort-on-error |
| A4 跨盘降级 | 自动识别 EXDEV；统一走"复制到 .partial → 校验 → 原子 rename"三段式 |
| A5 历史与撤销 | 每次迁移记录在案；一键撤销：从备份还原源目录、清目标、记账挂回原处 |
| B1 孤儿归位 | 扫描磁盘 vs 注册表差集，把"有档无账"的会话一键挂回 cwd 对应的工作区 |
| B2 分组建议 | 按会话标题 + 首条用户消息做 2-gram Jaccard 主题聚类，给出"建区+批量迁入"的可执行建议 |
| B3 排队迁移 | 正在写入的会话排队，日志静止 120 秒后自动执行 |

## 安装

方式一（推荐）：把本目录打成 tgz 后用插件管理器安装。

```powershell
cd dsh-session-relocate
npm pack                       # 产出 dsh-session-relocate-0.1.1.tgz
# 然后在 DSH 的插件管理器（dshmarket / plugin-manager）里从本地包安装
```

方式二（手工挂载，不依赖插件管理器）：

1. 把 `dsh-session-relocate` 整个目录复制到任意位置（例如 `<DSH_HOME>\` 下）；
2. 在 profile 的 `package.json`（`~/.dsh/profiles/desktop/package.json`）里：
   - `dependencies` 加 `"dsh-session-relocate": "file:C:/path/to/dsh-session-relocate"`（按实际路径）；
   - `dsh.profile.bundles` 数组追加 `"dsh-session-relocate"`；
3. 在 profile 目录执行 `pnpm install`（profile 用 pnpm，`nodeLinker: hoisted`）；
4. 重启 DSH。

> **改配置时务必不要引入 BOM。** DSH 用裸 `JSON.parse` 读 profile 的 `package.json`（`dsh-app-boot/lib/index.js` 的 `readProfileManifest`），而 JSON 标准不允许开头有 BOM。Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` **会写入 BOM**，会让 DSH 启动即崩（报 `Unexpected token '锘?, "...' is not valid JSON`）。用 Node 的 `fs.writeFileSync` 或编辑器保存为「UTF-8 无 BOM」。

> 本包声明了 `dsh.bundle.patch`（`cordis.patch.yml`），插件管理器安装时会自动并入 profile；手工安装时 bundle 列表本身即可让 DSH 加载包并合并其 patch。

## 使用

### 管理页（浏览器）

打开 DSH Web GUI 后访问 `<GUI根地址>/session-relocate`：

- 顶部显示默认工作区与会话/孤儿计数；
- 会话列表支持按工作区过滤、勾选；
- 目标可选**已有工作区**（下拉，默认工作区已禁选）或**新建工作区**（填目录绝对路径 + 标题，目录不存在会自动创建）；
- 「预演」先看 dry-run 报告；「迁移选中」执行；历史区可**一键撤销**；
- 「分组建议」按主题聚类给出归档方案。

> GUI 端口每次重启可能变化（`DSH_WEB_URL` 环境变量里是当前值），把 `/session-relocate` 拼到当前地址后面即可。

### Agent 工具（对话内直接让我迁移）

| 工具 | 说明 |
|---|---|
| `migration_overview` | 列出工作区与默认工作区（只读） |
| `migration_list_sessions` | 列出会话画像：标题/首条消息/帧数/孤儿（只读） |
| `migration_plan` | 迁移预演（只读，执行前先跑这个给你确认） |
| `migration_move` | 单条迁移（审批门） |
| `migration_batch` | 批量迁移（审批门） |
| `migration_history` | 迁移历史（只读） |
| `migration_undo` | 撤销一次迁移（审批门） |
| `migration_orphans` | 孤儿清单（只读） |
| `migration_adopt` | 孤儿归位，只改记账不动文件（审批门） |
| `migration_suggest_groups` | 分组建议（只读） |
| `migration_doctor` | 插件自检（只读） |

变更类工具都会先弹审批确认，未获准一律拒绝。

## DSH 集成要点（踩坑记录）

这几条是实测得出的，写下来免得后来者重蹈：

1. **`inject` 必须显式声明依赖服务。** `export const inject = []` 会让 `apply()` 在宿主服务挂载**之前**执行，此时 `ctx.get('webServer')` 拿不到服务，代码走进降级分支后**静默失效**（路由根本不注册，日志也不落盘）。正确做法：`export const inject = ['webServer', 'tools', ...]`。

2. **不要用 `connection.rpc.handle` 注册自定义通道（0.2.1-rc.2）。** 它的实现是：
   ```js
   get rpc() { const owner = this.ctx; return { handle: (ch, h) => this.register(owner, ch, h) } }
   // register() 内部：
   owner.effect(() => owner.webServer.register(route), ...)
   ```
   `owner` 是 **connection 服务自身的 fiber ctx**，它没有 inject `webServer`，于是 cordis 的注入守卫抛 `cannot get property "webServer" without inject`。**这与调用方怎么写无关**——把调用放进自己的 `ctx.inject` 回调里也一样崩，因为守卫检查的是服务侧。

   本插件的做法：只用 `webServer.register({ kind: 'prefix', path: '/session-relocate', handler })` 一个路由，自己接 HTTP 并解析 DSH 官方 `client-request` / `server-response` envelope。

3. **属性访问受注入守卫保护。** cordis 里 `ctx.get(key)` 会检查当前 fiber 是否声明了 `key`；需要额外服务时用 `ctx.inject([...], webCtx => ...)` 创建子 fiber，不要指望外层 `ctx` 能读所有服务。

4. **加载失败是静默的。** `logger.warn` 不落盘，插件的 `apply()` 抛错只会在 DSH 崩溃日志里留一行。本插件因此会在 `$DSH_HOME/logs/session-relocate-loaded.json` 写加载标记（含 `routeRegistered`、`mountEnteredAt` 等字段），排查时先读它。

## 安全设计

1. **先备份再动手**：源日志先字节级复制到 `<DSH_HOME>/storages/dsh-session-relocate-backup/`，备份失败则全程中止，什么都还没改。
2. **目标先 .partial 后 rename**：新日志写到目标父目录内的 `.partial-<pid>` 临时目录，读回校验（id、cwd、帧数、尾部字节）通过才原子 rename——同盘 rename 是原子的，断电也不会半写。
3. **注册表单次原子写**：备份后先改文件、再一次性写注册表（临时文件 + rename），失败自动删掉刚发布的新目录并抛错，源从未被破坏。
4. **默认删源，可选保留**：勾选"保留源"时源目录原样留在原地（会成为孤儿，可在孤儿区归位）。
5. **撤销是逆向迁移**：从备份还原（校验后才落盘）、清目标、记账挂回——同样走校验，不盲信备份。
6. **绝不碰运行中的会话**：日志 mtime 静止不足 120 秒的会话自动排队（B3），不抢写。

## 已知限制

- 只迁移 `session.v*.jsonl.zstd` 日志本体；附件按 sessionId 全局关联、id 不变，无需搬运。
- 投影缓存（`session_projcache`）不迁移，DSH 下次冷读会自动重建。
- 主题聚类是本地规则（2-gram Jaccard），不调用任何 LLM，不上传会话内容。
- 与 `dsh-workspace-mover` 不要同时启用同一会话的并发迁移（双方都会备份，不会损坏，但历史各自独立）。
- 自接 HTTP 路由意味着跳过了 `connection` 服务的鉴权封装。本插件只注册 loopback 可达的路径，且所有变更操作仍需用户确认；但若将来 DSH 提供可用的 channel 注册接缝，应改回官方通道。

## 测试

沙箱端到端（复制真实会话到临时 DSH_HOME，绝不碰真实档案）：把 `<DSH_HOME>/sessions` 下某个工作区的会话目录复制到临时目录，指向它后跑迁移 → 校验 → 撤销全链路。核心断言点：

- 迁移后源目录消失、目标目录出现、首帧 `cwd` 已改写、session id 不变
- 注册表里会话已从原工作区摘除、挂到目标工作区
- 撤销后源目录还原、目标清除、记账挂回、首帧 `cwd` 还原
- 批量迁移批次状态为 `done`，分组建议返回合法结构
