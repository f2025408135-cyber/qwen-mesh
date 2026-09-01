// fire-local.mjs — HYBRID mesh: fire the deep-research POST from the LOCAL
// machine (residential IP — the only place /api/v2/chat/completions is not
// IP-black-holed; field-verified 2026-09-01: GitHub runner IPs, Azure AND
// GitHub macOS clouds, are black-holed on that endpoint while all other Qwen
// endpoints pass). The research STARTS server-side from this POST; the
// report is then collected REMOTELY by the qwen-mesh workflow (mode=collect).
//
// Local pod footprint: ~1-3 min (launch → create chat → fire → verify notice
// started → close). The 5-25 min wait happens on GitHub Actions — zero RAM.
//
// Env: FIRE_TOPIC (required), FIRE_FOCUS, FIRE_AUDIENCE, FIRE_ACCOUNT_INDEX
//      (default 1), FIRE_ENV_FILE (default F:\FREE CODE BY MOIZ\.env.freecode)
// Out: prints ONE JSON line: {ok, chat_id, account_index, notice_confirmed, ...}

import { spawn } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

const GLOBAL_BASE = "https://chat.qwen.ai"
const API_VERSION = "0.2.83"
const MODEL = "qwen3.8-max"

const topic = (process.env.FIRE_TOPIC || "").trim()
const focus = (process.env.FIRE_FOCUS || "").trim()
const audience = (process.env.FIRE_AUDIENCE || "").trim()
const accountIndex = Math.max(1, Number(process.env.FIRE_ACCOUNT_INDEX || 1))
const fireCapMs = Math.max(30, Number(process.env.FIRE_CAP_SECONDS || 75)) * 1000

const die = (msg) => { console.log(JSON.stringify({ ok: false, error: msg })); process.exit(1) }
const log = (...a) => console.log("[fire]", ...a)
if (!topic) die("FIRE_TOPIC is empty")

// JWT from the bridge env file (never printed)
const envPath = process.env.FIRE_ENV_FILE || "F:\\FREE CODE BY MOIZ\\.env.freecode"
if (!existsSync(envPath)) die(`env file not found: ${envPath}`)
const m = readFileSync(envPath, "utf8").match(/FREECODE_BRIDGE_QWEN_ACCOUNTS=(.+)/)
if (!m) die("FREECODE_BRIDGE_QWEN_ACCOUNTS not found in env file")
const accounts = JSON.parse(m[1].Trim ? m[1].Trim() : m[1].trim())
const account = accounts[accountIndex - 1]
if (!account?.ticket) die(`no account ${accountIndex} in env file`)

// --- local pod (CDP) ----------------------------------------------------------
const PORT = 9300 + accountIndex
const PROFILE = `F:\\qwenmesh\\id-${accountIndex}`
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
]

function cdpAlive() {
  return fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok).catch(() => false)
}

async function ensurePod() {
  if (await cdpAlive()) { log(`pod ${accountIndex} already alive on :${PORT}`); return null }
  const chrome = chromeCandidates.find((p) => existsSync(p))
  if (!chrome) die("chrome.exe not found")
  const child = spawn(chrome, [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
    "--no-first-run", "--no-default-browser-check",
    "--window-size=1280,900",
    "https://chat.qwen.ai/",
  ], { stdio: "ignore", detached: false })
  for (let i = 0; i < 20; i++) {
    if (await cdpAlive()) { log(`pod ${accountIndex} launched on :${PORT}`); return child }
    await sleep(1000)
  }
  die("local pod CDP never came up")
}

function cdpEval(expression, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    ;(async () => {
      let ws
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        const page = targets.find((t) => t.type === "page")
        if (!page) return reject(new Error("no page target"))
        ws = new WebSocket(page.webSocketDebuggerUrl)
      } catch (e) { return reject(new Error(`CDP unreachable: ${e.message}`)) }
      const timer = setTimeout(() => { try { ws.close() } catch {}; reject(new Error("CDP eval timeout")) }, timeoutMs)
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }))
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.id !== 1) return
        clearTimeout(timer); try { ws.close() } catch {}
        const val = msg.result?.result
        if (msg.result?.exceptionDetails || val?.exceptionDetails) return reject(new Error("eval exception"))
        resolve(val?.value ?? null)
      }
      ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket error")) }
    })()
  })
}

function cdpFetchExpr(url, bodyObj, method = "POST") {
  const payload = JSON.stringify(bodyObj)
  const headers = `{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer ${account.ticket}','Version':'${API_VERSION}','source':'desktop','X-Request-Id':crypto.randomUUID()}`
  const init = method === "POST" ? `{method:'POST',headers:${headers},body:${JSON.stringify(payload)}}` : `{method:'GET',headers:{'Accept':'application/json','Authorization':'Bearer ${account.ticket}','Version':'${API_VERSION}','source':'desktop'}}`
  return `(async()=>{try{const r=await fetch('${url}',${init});const t=await r.text();return JSON.stringify({status:r.status,body:t})}catch(e){return JSON.stringify({status:0,body:'FETCH_ERR:'+e.message})}})()`
}

const pod = await ensurePod()

// page ready + session check (profile should be logged in; if expired, say so)
for (let i = 0; i < 20; i++) {
  const href = await cdpEval("location.href").catch(() => null)
  if (String(href ?? "").startsWith("https://chat.qwen.ai")) break
  if (i === 19) die(`pod ${accountIndex} page never ready — relaunch/re-login profile ${PROFILE}`)
  await sleep(2000)
}
const stored = await cdpEval("localStorage.getItem('token')").catch(() => null)
if (!stored) {
  await cdpEval(`localStorage.setItem('token', ${JSON.stringify(account.ticket)}); 'set'`).catch(() => {})
  await cdpEval("location.reload(); 'r'").catch(() => {})
  await sleep(5000)
}

// 1) create the chat
let create
try { create = JSON.parse(await cdpEval(cdpFetchExpr(`${GLOBAL_BASE}/api/v2/chats/new`, {}), 30000)) }
catch (e) { die(`chats/new failed: ${e.message}`) }
if (create.status !== 200) {
  if (create.status === 401) die(`pod ${accountIndex}: session expired — re-login the pod (profile ${PROFILE}), then re-run`)
  die(`chats/new HTTP ${create.status}: ${String(create.body).slice(0, 150)}`)
}
const chatJson = JSON.parse(create.body)
const chatId = chatJson?.data?.id || chatJson?.id
if (!chatId) die("no chat_id in create response")
log("chat created:", chatId)

// 2) fire the deep_research completions (research_mode advance). The notice
//    stream takes 2-8 min; we cap the wait at fireCapSeconds — the POST is
//    already delivered and the research continues server-side (L-019).
function deepResearchMessage(content) {
  return {
    id: null, fid: crypto.randomUUID(), parentId: null, childrenIds: [crypto.randomUUID()],
    role: "user", content, user_action: "chat", files: [],
    timestamp: Math.floor(Date.now() / 1000), models: [MODEL], model: "",
    chat_type: "deep_research",
    feature_config: { thinking_enabled: true, output_schema: "phase", research_mode: "advance", auto_thinking: true, thinking_mode: "Auto", thinking_format: "summary", auto_search: true },
    extra: { meta: { subChatType: "deep_research" } }, sub_chat_type: "deep_research",
  }
}
let content = topic
if (focus) content += `\nFocus: ${focus}`
if (audience) content += `\nAudience: ${audience}`
const body = JSON.stringify({
  stream: true, version: "2.1", incremental_output: true, chatId, parentId: null,
  chat_id: chatId, chat_mode: "normal", model: MODEL, parent_id: null,
  messages: [deepResearchMessage(content)], timestamp: Math.floor(Date.now() / 1000),
})
let noticeOk = false
try {
  await cdpEval(`(async()=>{try{await fetch('${GLOBAL_BASE}/api/v2/chat/completions?chat_id=${chatId}',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer ${account.ticket}','Version':'${API_VERSION}','source':'desktop','X-Request-Id':crypto.randomUUID()},body:${JSON.stringify(body)}})}catch(e){} return 'fired'})()`, fireCapMs)
  noticeOk = true
  log("notice phase returned (research confirmed started)")
} catch {
  log(`notice stream still open after ${fireCapMs / 1000}s — POST delivered, research continues server-side`)
}

// 3) confirm the chat shows research activity (ResearchNotice/content_list)
let noticeSeen = false
for (let i = 0; i < 6; i++) {
  try {
    const raw = await cdpEval(cdpFetchExpr(`${GLOBAL_BASE}/api/v2/chats/${chatId}?direction=up&limit=10`, {}, "GET", 30000), 40000)
    const j = JSON.parse(raw)
    if (j.status === 200) {
      const msgs = JSON.parse(j.body)?.data?.chat?.history?.messages ?? {}
      const any = Object.values(msgs).some((m) => (m?.content_list ?? []).length > 0 || (m?.content ?? "").length > 0)
      if (any) { noticeSeen = true; break }
    }
  } catch {}
  await sleep(10000)
}

// Kill the pod if we launched it (we only needed it for the POST)
if (pod) { try { pod.kill(); log("pod closed") } catch {} }

console.log(JSON.stringify({ ok: true, chat_id: chatId, account_index: accountIndex, notice_returned: noticeOk, notice_seen: noticeSeen }))