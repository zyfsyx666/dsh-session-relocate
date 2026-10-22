/**
 * 存储布局：把 cwd / sessionId 编码成会话目录路径。
 *
 * 编码规则移植自 @deepseek-ai/dsh-session-persistence-jsonl（与实测目录名逐一吻合）：
 *   D:\工作区\微信  ->  --D-~5DE5~4F5C~533A-~5FAE~4FE1--
 *   C:\Users\x\a   ->  --C-Users-x-a--
 */
import { homedir } from 'node:os'
import path from 'node:path'

/** DSH 安装根（会话与存储都在其下）。 */
export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(homedir(), '.dsh')
}

export function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

export function storagesRoot() {
  return path.join(dshHome(), 'storages')
}

/** 单段编码：仅保留 [A-Za-z0-9._-]，其余转 ~XXXX。 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** cwd -> 项目目录名：连续分隔符压成一个 '-'，首尾各补 '--'。 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 会话目录：<sessions>/<projectKey(cwd)>/<encodeSegment(id)> */
export function sessionDirFor(cwd, sessionId, root = sessionsRoot()) {
  return path.join(root, projectKey(cwd), encodeSegment(sessionId))
}

/** 会话日志文件名（当前格式代际 v4）。 */
export const LOG_FILENAME = 'session.v4.jsonl.zstd'

/** 版本 → 日志文件名；v0 无后缀。 */
export function logFilename(version = 4) {
  return version === 0 ? 'session.jsonl.zstd' : `session.v${version}.jsonl.zstd`
}

/** 默认根目录：与 DSH 首次使用工作区一致（<Documents>/deepseek-harness）。 */
export function defaultWorkspaceParent() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir()
  if (process.platform === 'win32') {
    return path.join(home, 'Documents', 'deepseek-harness')
  }
  // macOS/Linux：Documents 位置由 xdg-user-dir 决定，这里退化为用户目录
  return path.join(home, 'deepseek-harness')
}
