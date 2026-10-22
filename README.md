# dsh-session-relocate

在 DSH（DeepSeek Harness）里**安全迁移会话**：把 `default-workspace` 里堆积的对话，批量搬到已有工作区或新建工作区。真迁移——保持 session id 与完整历史，只改写首帧 `cwd`；迁移前做字节级备份，失败自动回滚，支持一键撤销。

> 兼容：DSH `0.2.1-rc.2`（实测验证）；Node ≥ 22（依赖 `node:zlib` 的 zstd）。

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
npm pack                       # 产出 dsh-session-relocate-0.1.0.tgz
# 然后在 DSH 的插件管理器（dshmarket / plugin-manager）里从本地包安装
```

方式二（手工挂载，不依赖插件管理器）：

1. 把 `dsh-session-relocate` 整个目录复制到任意位置（例如 `<DSH_HOME>\` 下）；
2. 在 profile 的 `package.json`（`~/.dsh/profiles/desktop/package.json`）里：
   - `dependencies` 加 `"dsh-session-relocate": "file:C:/Users/38869/.dsh/dsh-session-relocate"`（按实际路径）；
   - `dsh.profile.bundles` 数组追加 `"dsh-session-relocate"`；
3. 在 profile 目录执行 `pnpm install`（profile 用 pnpm，`nodeLinker: hoisted`）；
4. 重启 DSH。

> 本包声明了 `dsh.bundle.patch`（`cordis.patch.yml`），插件管理器安装时会自动并入 profile；手工安装时 bundle 列表本身即可让 DSH 加载包并合并其 patch。

## 使用

### 管理页（浏览器）

打开 DSH Web GUI 后访问 `<GUI根地址>/workspace-migration`：

- 顶部显示默认工作区与会话/孤儿计数；
- 会话列表支持按工作区过滤、勾选；
- 目标可选**已有工作区**（下拉，默认工作区已禁选）或**新建工作区**（填目录绝对路径 + 标题，目录不存在会自动创建）；
- 「预演」先看 dry-run 报告；「迁移选中」执行；历史区可**一键撤销**；
- 「分组建议」按主题聚类给出归档方案。

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

## 测试

沙箱端到端（复制真实会话到临时 DSH_HOME，绝不碰真实档案）：

```powershell
cd _research
# 先建沙箱（见 test-migrate.mjs 顶部说明），然后：
$env:DSH_HOME = "<...>\_research\sandbox\dsh-home"
node test-migrate.mjs   # 24 项断言：迁移/校验/注册表/撤销/批量/分组/历史
```
