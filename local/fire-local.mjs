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
const fireCapMs = Math.max(30, Number(process.env.FIRE_CAP_SECONDS || 300)) * 1000

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

// --- WAF helpers (fresh profiles have NO cookie jar: challenge + punish) ------
const isPunish = (s) => /RGV587|____tmd_____|punish|FAIL_SYS_USER_VALIDATE/i.test(String(s ?? ""))

// Let the page's WAF JS challenge settle (fresh profiles need this before any
// POST passes; field-verified 2026-09-04: first-contact chats/new returns a
// punish body with no data.id until the challenge cookies are issued).
async function settleChallenge() {
  for (let i = 0; i < 4; i++) {
    await sleep(8000)
    try {
      const cookies = await cdpEval("document.cookie", 15000)
      const hasClearance = /acw_tc|x5sec|acw_sc/i.test(String(cookies ?? ""))
      log(`challenge settle ${i + 1}/4: clearance cookies ${hasClearance ? "PRESENT" : "absent"}`)
      if (hasClearance) return true
    } catch {}
  }
  return false
}

// chats/new with punish-aware retries (first contact can be challenged).
async function createChatRetry(tries = 3, gapMs = 8000) {
  for (let i = 0; i < tries; i++) {
    let raw = null
    try {
      raw = await cdpEval(cdpFetchExpr(`${GLOBAL_BASE}/api/v2/chats/new`, {}), 30000)
      const j = JSON.parse(raw)
      const id = j?.data?.id || j?.id
      if (id) return id
      log(`chats/new try ${i + 1}/${tries}: no id${isPunish(j) ? " (WAF punish body)" : ""}: ${String(raw).slice(0, 120)}`)
    } catch (e) { log(`chats/new try ${i + 1}/${tries} error: ${e.message}`) }
    if (i < tries - 1) await sleep(gapMs)
  }
  return null
}

// WAF WARM-UP for history-less accounts (6-25): settle the challenge, then one
// normal greeting exchange (non-stream) in the SAME browser session BEFORE the
// deep_research POST. Field-verified 2026-09-04: fresh-JWT cookie-less accounts
// get deep_research silently dropped/punished; a normal exchange unlocks it
// (operator-verified manually in a logged-in session). FIRE_WARMUP=0 disables.
const wantWarmup = (process.env.FIRE_WARMUP || "1") !== "0"
let warmupOk = false
let warmupChatId = null
if (wantWarmup) {
  await settleChallenge()
  for (let attempt = 1; attempt <= 2 && !warmupOk; attempt++) {
    warmupChatId = await createChatRetry()
    if (!warmupChatId) { log(`warm-up attempt ${attempt}: no warmup chat_id`); await sleep(10000); continue }
    try {
      const wMsg = {
        id: null, fid: crypto.randomUUID(), parentId: null, childrenIds: [crypto.randomUUID()],
        role: "user", content: "Hello! Just saying hi - how are you today?", user_action: "chat", files: [],
        timestamp: Math.floor(Date.now() / 1000), models: [MODEL], model: "", chat_type: "chat",
        feature_config: { thinking_enabled: false, output_schema: "message", research_mode: "normal", auto_thinking: false, thinking_mode: "Auto", thinking_format: "summary", auto_search: false },
        extra: {}, sub_chat_type: "",
      }
      const wBody = JSON.stringify({
        stream: false, version: "2.1", incremental_output: false, chatId: warmupChatId, parentId: null,
        chat_id: warmupChatId, chat_mode: "normal", model: MODEL, parent_id: null,
        messages: [wMsg], timestamp: Math.floor(Date.now() / 1000),
      })
      const wPost = JSON.parse(await cdpEval(`(async()=>{try{const r=await fetch('${GLOBAL_BASE}/api/v2/chat/completions?chat_id=${warmupChatId}',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer ${account.ticket}','Version':'${API_VERSION}','source':'desktop','X-Request-Id':crypto.randomUUID()},body:${JSON.stringify(wBody)}});const t=await r.text();return JSON.stringify({status:r.status,head:t.slice(0,160)})}catch(e){return JSON.stringify({status:0,error:e.message})}})()`, 90000))
      // 200 is NOT enough — the WAF returns 200 with a punish BODY (RGV587).
      warmupOk = wPost.status === 200 && !isPunish(wPost.head)
      log(`warm-up attempt ${attempt}: ${warmupOk ? "ok (assistant replied)" : `blocked ${JSON.stringify(wPost).slice(0, 140)}`} (chat ${warmupChatId})`)
      if (!warmupOk) await sleep(12000)
    } catch (e) { log(`warm-up attempt ${attempt} error: ${e.message}`); await sleep(10000) }
  }
} else { log("warm-up disabled (FIRE_WARMUP=0)") }

// 1) create the chat
let create
try { create = JSON.parse(await cdpEval(cdpFetchExpr(`${GLOBAL_BASE}/api/v2/chats/new`, {}), 30000)) }
catch (e) { die(`chats/new failed: ${e.message}`) }
if (create.status !== 200) {
  if (create.status === 401) die(`pod ${accountIndex}: session expired — re-login the pod (profile ${PROFILE}), then re-run`)
  die(`chats/new HTTP ${create.status}: ${String(create.body).slice(0, 150)}`)
}
const chatJson = JSON.parse(create.body)
let chatId = chatJson?.data?.id || chatJson?.id
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
let postStatus = 0
let postPunished = false
try {
  postStatus = await cdpEval(`(async()=>{try{const r=await fetch('${GLOBAL_BASE}/api/v2/chat/completions?chat_id=${chatId}',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer ${account.ticket}','Version':'${API_VERSION}','source':'desktop','X-Request-Id':crypto.randomUUID()},body:${JSON.stringify(body)}});const st=r.status;const t=await r.text();return JSON.stringify({status:st,bodyLen:t.length,head:t.slice(0,200)})}catch(e){return JSON.stringify({status:0,error:e.message})}})()`, fireCapMs)
  const postResult = JSON.parse(postStatus)
  postStatus = postResult.status
  log("completions POST:", JSON.stringify(postResult).slice(0, 300))
  // 200 is NOT success by itself: the WAF returns 200 with a punish BODY (RGV587).
  postPunished = isPunish(postResult.head)
  noticeOk = postResult.status === 200 && !postPunished
} catch {
  log(`completions POST eval timed out after ${fireCapMs / 1000}s (stream may be open)`)
}

// If the research POST was WAF-punished: settle + redo warm-up + ONE research
// retry in a fresh chat (the punished chat has no research server-side).
if (postPunished) {
  log("research POST WAF-punished — settling, redoing warm-up, one research retry")
  try {
    await settleChallenge()
    await createChatRetry(1, 0).then(() => {})
    const retryWarm = await (async () => { // one more greeting exchange
      const rc = await createChatRetry(2, 8000)
      if (!rc) return false
      try {
        const rMsg = { id: null, fid: crypto.randomUUID(), parentId: null, childrenIds: [crypto.randomUUID()], role: "user", content: "Hello again! How is your day going?", user_action: "chat", files: [], timestamp: Math.floor(Date.now() / 1000), models: [MODEL], model: "", chat_type: "chat", feature_config: { thinking_enabled: false, output_schema: "message", research_mode: "normal", auto_thinking: false, thinking_mode: "Auto", thinking_format: "summary", auto_search: false }, extra: {}, sub_chat_type: "" }
        const rBody = JSON.stringify({ stream: false, version: "2.1", incremental_output: false, chatId: rc, parentId: null, chat_id: rc, chat_mode: "normal", model: MODEL, parent_id: null, messages: [rMsg], timestamp: Math.floor(Date.now() / 1000) })
        const rPost = JSON.parse(await cdpEval(`(async()=>{try{const r=await fetch('${GLOBAL_BASE}/api/v2/chat/completions?chat_id=${rc}',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer ${account.ticket}','Version':'${API_VERSION}','source':'desktop','X-Request-Id':crypto.randomUUID()},body:${JSON.stringify(rBody)}});const t=await r.text();return JSON.stringify({status:r.status,head:t.slice(0,160)})}catch(e){return JSON.stringify({status:0,error:e.message})}})()`, 90000))
        return rPost.status === 200 && !isPunish(rPost.head)
      } catch { return false }
    })()
    log(`retry warm-up: ${retryWarm ? "ok" : "failed"}`)
    const retryChat = await createChatRetry()
    if (retryChat) {
      const retryBody = JSON.stringify({
        stream: true, version: "2.1", incremental_output: true, chatId: retryChat, parentId: null,
        chat_id: retryChat, chat_mode: "normal", model: MODEL, parent_id: null,
        messages: [deepResearchMessage(content)], timestamp: Math.floor(Date.now() / 1000),
      })
      const retryPost = JSON.parse(await cdpEval(`(async()=>{try{const r=await fetch('${GLOBAL_BASE}/api/v2/chat/completions?chat_id=${retryChat}',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer ${account.ticket}','Version':'${API_VERSION}','source':'desktop','X-Request-Id':crypto.randomUUID()},body:${JSON.stringify(retryBody)}});const t=await r.text();return JSON.stringify({status:r.status,head:t.slice(0,200)})}catch(e){return JSON.stringify({status:0,error:e.message})}})()`, fireCapMs))
      log("research retry POST:", JSON.stringify(retryPost).slice(0, 300))
      if (retryPost.status === 200 && !isPunish(retryPost.head)) { chatId = retryChat; noticeOk = true; postStatus = 200; postPunished = false }
    }
  } catch (e) { log(`research retry error: ${e.message}`) }
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

console.log(JSON.stringify({ ok: true, chat_id: chatId, account_index: accountIndex, completions_status: postStatus, notice_returned: noticeOk, notice_seen: noticeSeen, warmup_ok: warmupOk, warmup_chat_id: warmupChatId, post_punished: postPunished, research_chat_final: chatId !== (chatJson?.data?.id || chatJson?.id) }))