// 用 GitHub REST Contents API 把仓库文件逐个上传（绕开被重置的 git 协议）
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const TOKEN = process.env.GH_PAT
const OWNER = "zyfsyx666"
const REPO = "dsh-session-relocate"
const API = "https://api.github.com"

if (!TOKEN) throw new Error("缺少 GH_PAT")

const headers = {
  authorization: `Bearer ${TOKEN}`,
  "user-agent": "dsh-session-relocate-publish",
  accept: "application/vnd.github+json",
  "content-type": "application/json",
}

async function call(method, url, body) {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, ok: res.ok, json }
}

// 1) 验证 token
const who = await call("GET", `${API}/user`)
if (!who.ok) {
  console.log("TOKEN INVALID:", who.status, JSON.stringify(who.json).slice(0, 300))
  process.exit(1)
}
console.log(`token OK, user = ${who.json.login}`)

// 2) 收集要上传的文件（排除 .git / .deploy-keys / node_modules / *.tgz）
const SKIP_DIRS = new Set([".git", ".deploy-keys", "node_modules"])
const SKIP_EXT = /\.tgz$/
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const rel = path.relative(process.cwd(), full).replace(/\\/g, "/")
    if (SKIP_DIRS.has(name) || SKIP_EXT.test(name)) continue
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else out.push(rel)
  }
  return out
}
const files = walk(process.cwd())
console.log(`待上传 ${files.length} 个文件`)

// 3) 逐个 PUT（先试 main，若仓库空则第一次会建分支）
let failed = 0
for (const rel of files) {
  const content = readFileSync(rel).toString("base64")
  const url = `${API}/repos/${OWNER}/${REPO}/contents/${encodeURI(rel).replace(/#/g, "%23")}`
  // 已存在则取 sha 以更新
  const existing = await call("GET", url)
  const body = { message: `add ${rel}`, content, branch: "main" }
  if (existing.ok && existing.json?.sha) body.sha = existing.json.sha
  const res = await call("PUT", url, body)
  if (res.ok) console.log(`  OK   ${rel}`)
  else {
    failed += 1
    console.log(`  FAIL ${rel} -> ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`)
  }
  await new Promise((r) => setTimeout(r, 300)) // 避免触发秒级限流
}
console.log(failed === 0 ? "\nALL UPLOADED" : `\n${failed} 个失败`)
process.exit(failed === 0 ? 0 : 2)
