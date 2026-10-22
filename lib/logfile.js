/**
 * 会话日志（session.v4.jsonl.zstd）= zstd **多帧拼接**：
 *   第 1 帧 = SessionHeader 一行 JSON（约 244 字节解压后）
 *   其后每帧 = 一批事件
 *
 * 因此「迁移」只需重写首帧的 cwd，其余帧逐字节保留 —— 不重新编码事件。
 */
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
/** Frame_Content_Size_flag -> 字节数（flag 0 单独处理） */
const FCS_BYTES = [0, 2, 4, 8]

export class CorruptLogError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'CorruptLogError'
  }
}

/**
 * 扫描 zstd 拼接帧边界，产出 [start, end)。只做边界判定，不解压。
 * 遇到非法 magic / 撕裂块都抛 CorruptLogError —— 调用方据此拒绝迁移。
 */
export function* zstdFrames(buf) {
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) throw new CorruptLogError(`truncated frame magic at ${offset}`)
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new CorruptLogError(`invalid frame magic at ${offset}`)
    }
    offset += 4
    if (offset >= buf.length) throw new CorruptLogError('torn frame descriptor')
    const descriptor = buf[offset++]
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const hasChecksum = (descriptor >> 2) & 1
    const dictFlag = descriptor & 3
    if (!singleSegment) {
      if (offset >= buf.length) throw new CorruptLogError('torn window descriptor')
      offset += 1
    }
    if (dictFlag === 1) offset += 1
    else if (dictFlag === 2) offset += 2
    else if (dictFlag === 3) offset += 4
    const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : FCS_BYTES[fcsFlag]
    offset += fcsBytes
    if (offset > buf.length) throw new CorruptLogError('torn frame header')
    for (;;) {
      if (buf.length - offset < 3) throw new CorruptLogError('torn block header')
      const header = buf.readUIntLE(offset, 3)
      offset += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >>> 3
      if (type === 3) throw new CorruptLogError('reserved block type')
      const contentBytes = type === 1 ? 1 : size // RLE 块内容恒为 1 字节
      if (buf.length - offset < contentBytes) throw new CorruptLogError('torn block payload')
      offset += contentBytes
      if (last) break
    }
    if (hasChecksum) {
      if (buf.length - offset < 4) throw new CorruptLogError('torn content checksum')
      offset += 4
    }
    yield [start, offset]
  }
}

/** 读取首帧 SessionHeader（一行 JSON）。 */
export function readHeader(buf) {
  const first = zstdFrames(buf).next()
  if (first.done) throw new CorruptLogError('empty session log')
  const [start, end] = first.value
  let text
  try {
    text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
  } catch (cause) {
    throw new CorruptLogError('header frame does not decompress', { cause })
  }
  const line = text.split('\n', 1)[0]
  let header
  try {
    header = JSON.parse(line)
  } catch (cause) {
    throw new CorruptLogError('header frame is not valid JSON', { cause })
  }
  if (header?.type !== 'session') throw new CorruptLogError('first record is not a session header')
  return header
}

/** 只重写首帧的 cwd，其余字节原样拼接。 */
export function rewriteHeaderCwd(buf, nextCwd) {
  const header = readHeader(buf)
  const first = zstdFrames(buf).next()
  const [, end] = first.value
  header.cwd = nextCwd
  const frame = zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
  return Buffer.concat([frame, buf.subarray(end)])
}

/**
 * 迁移前的健康校验：
 *  - 全部帧边界可解析（没有撕裂尾部）
 *  - 首帧 id 与预期一致
 *  - 指定时 cwd 与预期一致
 * 返回 { frames, header }。
 */
export function verifyLog(buf, { sessionId, cwd } = {}) {
  let frames = 0
  for (const _ of zstdFrames(buf)) frames += 1
  if (frames === 0) throw new CorruptLogError('empty session log')
  const header = readHeader(buf)
  if (sessionId !== undefined && header.id !== sessionId) {
    throw new CorruptLogError(`header id ${JSON.stringify(header.id)} does not match ${JSON.stringify(sessionId)}`)
  }
  if (cwd !== undefined && header.cwd !== cwd) {
    throw new CorruptLogError(`header cwd ${JSON.stringify(header.cwd)} does not match ${JSON.stringify(cwd)}`)
  }
  return { frames, header }
}

/** 统计帧数与首帧 header（不校验 cwd），用于预演报告。 */
export function inspectLog(buf) {
  let frames = 0
  for (const _ of zstdFrames(buf)) frames += 1
  return { frames, header: readHeader(buf), bytes: buf.length }
}
