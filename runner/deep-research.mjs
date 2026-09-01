// deep-research.mjs — remote Qwen pod runner for GitHub Actions.
// One job = one headless chromium pod = one logged-in Qwen account (JWT via
// localStorage) = one deep research. Protocol ported byte-for-byte from
// services/bridges/qwen/src/global.js (verified live 2026-08-11/12).
//
// WAF safety: every Qwen API call runs as in-page fetch() inside the pod page
// via CDP (Runtime.evaluate), so requests carry the page's cookie context.
// Plain HTTP with a raw JWT gets RGV587/x5sec punish — never do it here.
//
// Inputs (env): QWEN_JWT_1..5, INPUT_TOPIC, INPUT_FOCUS, INPUT_AUDIENCE,
//               INPUT_MAX_WAIT_SECONDS (default 1500), INPUT_ACCOUNT_INDEX,
//               INPUT_MODE ('spike' | 'research').
// Outputs (out/): result.json, report.md, report.pdf (research mode).
// Secrets never touch disk or artifacts — they exist only in env/memory.

import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

const GLOBAL_BASE = "https://chat.qwen.ai"
const API_VERSION = "0.2.83"
const DEFAULT_GLOBAL_MODEL = "qwen3.8-max"
const CDP_PORT = 9310
const OUT_DIR = "out"

const mode = (process.env.INPUT_MODE || "research").toLowerCase()
const topic = (process.env.INPUT_TOPIC || "").trim()
const focus = (process.env.INPUT_FOCUS || "").trim()
const audience = (process.env.INPUT_AUDIENCE || "").trim()
const maxWaitMs = Math.max(120, Number(process.env.INPUT_MAX_WAIT_SECONDS || 1500)) * 1000
const accountIndex = Math.min(5, Math.max(1, Number(process.env.INPUT_ACCOUNT_INDEX || 1)))
const token = (process.env[`QWEN_JWT_${accountIndex}`] || "").trim()

const t0 = Date.now()
const log = (...a) => console.log(`[pod ${accountIndex} +${Math.round((Date.now() - t0) / 1000)}s]`, ...a)
const fail = (status, msg, extra = {}) => {
  const result = { ok: false, status, account_index: accountIndex, mode, error: msg, elapsed_sec: Math.round((Date.now() - t0) / 1000), ...extra }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(`${OUT_DIR}/result.json`, JSON.stringify(result, null, 2))
  log("FAILED:", status, msg)
  process.exit(1)
}

if (!token) fail(400, `QWEN_JWT_${accountIndex} secret is empty`)
if (mode === "research" && !topic) fail(400, "INPUT_TOPIC is empty in research mode")

// --- CDP transport (identical semantics to global.js cdpEval) ----------------
function cdpEval(expression, timeoutMs = 320000) {
  return new Promise((resolve, reject) => {
    ;(async () => {
      let ws
      try {
        const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
        const page = targets.find((t) => t.type === "page")
        if (!page) return reject(new Error("no page target (browser closed?)"))
        ws = new WebSocket(page.webSocketDebuggerUrl)
      } catch (e) {
        return reject(new Error(`CDP unreachable: ${e.message}`))
      }
      const timer = setTimeout(() => {
        try { ws.close() } catch {}
        reject(new Error("CDP eval timeout"))
      }, timeoutMs)
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }))
        } catch (e) { clearTimeout(timer); reject(e) }
      }
      ws.onmessage = (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.id !== 1) return
        clearTimeout(timer)
        try { ws.close() } catch {}
        const val = msg.result?.result
        if (msg.result?.exceptionDetails || val?.exceptionDetails) {
          return reject(new Error(`eval exception: ${JSON.stringify(val?.exceptionDetails ?? msg.result?.exceptionDetails).slice(0, 300)}`))
        }
        resolve(val?.value ?? null)
      }
      ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket error")) }
    })()
  })
}

/** In-page fetch expression (identical shape to global.js cdpFetchExpr). */
function cdpFetchExpr(url, bodyObj, method = "POST") {
  const payload = JSON.stringify(bodyObj)
  const headers = `{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer ${token}','Version':'${API_VERSION}','source':'desktop','X-Request-Id':crypto.randomUUID()}`
  const init = method === "POST" ? `{method:'POST',headers:${headers},body:${JSON.stringify(payload)}}` : `{method:'GET',headers:{'Accept':'application/json','Authorization':'Bearer ${token}','Version':'${API_VERSION}','source':'desktop'}}`
  return `(async()=>{try{const r=await fetch('${url}',${init});const t=await r.text();return JSON.stringify({status:r.status,body:t})}catch(e){return JSON.stringify({status:0,body:'FETCH_ERR:'+e.message})}})()`
}

async function qwenApi(path, bodyObj, method = "POST", timeoutMs = 120000) {
  const raw = await cdpEval(cdpFetchExpr(`${GLOBAL_BASE}${path}`, bodyObj, method), timeoutMs)
  let data
  try { data = JSON.parse(raw) } catch { throw Object.assign(new Error(`bad qwen response: ${String(raw).slice(0, 200)}`), { status: 502 }) }
  if (data.status === 0 && String(data.body).startsWith("FETCH_ERR")) throw Object.assign(new Error(data.body), { status: 502 })
  if (data.status !== 200) {
    const err = new Error(`qwen HTTP ${data.status}: ${String(data.body).slice(0, 250)}`)
    err.status = data.status === 401 ? 401 : data.status === 429 ? 429 : data.status === 403 ? 403 : 502
    if (data.status === 401) err.class = "auth"
    throw err
  }
  return JSON.parse(data.body)
}

// --- Wire format (copied verbatim from global.js) ----------------------------
function deepResearchMessage(content) {
  return {
    id: null,
    fid: crypto.randomUUID(),
    parentId: null,
    childrenIds: [crypto.randomUUID()],
    role: "user",
    content,
    user_action: "chat",
    files: [],
    timestamp: Math.floor(Date.now() / 1000),
    models: [DEFAULT_GLOBAL_MODEL],
    model: "",
    chat_type: "deep_research",
    feature_config: {
      thinking_enabled: true,
      output_schema: "phase",
      research_mode: "advance", // ADVANCED deep research — "deep" is legacy/normal
      auto_thinking: true,
      thinking_mode: "Auto",
      thinking_format: "summary",
      auto_search: true,
    },
    extra: { meta: { subChatType: "deep_research" } },
    sub_chat_type: "deep_research",
  }
}

function userMessage(content) {
  return {
    id: null,
    fid: crypto.randomUUID(),
    parentId: null,
    childrenIds: [crypto.randomUUID()],
    role: "user",
    content,
    user_action: "chat",
    files: [],
    timestamp: Math.floor(Date.now() / 1000),
    models: [DEFAULT_GLOBAL_MODEL],
    model: "",
    chat_type: "chat",
    feature_config: { thinking_enabled: true, output_schema: "phase", research_mode: "normal", auto_thinking: true, thinking_mode: "Auto", thinking_format: "summary", auto_search: false },
    extra: {},
    sub_chat_type: "",
  }
}

function completionsBody(chatId, messages) {
  return {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chatId,
    parentId: null,
    chat_id: chatId,
    chat_mode: "normal",
    model: DEFAULT_GLOBAL_MODEL,
    parent_id: null,
    messages,
    timestamp: Math.floor(Date.now() / 1000),
  }
}

async function createChat() {
  const j = await qwenApi("/api/v2/chats/new", {})
  const chatId = j?.data?.id || j?.id
  if (!chatId) throw Object.assign(new Error(`no chat_id in create response: ${JSON.stringify(j).slice(0, 200)}`), { status: 502 })
  return chatId
}

function extractResearchReport(chatJson) {
  const msgs = chatJson?.data?.chat?.history?.messages ?? {}
  for (const [mid, m] of Object.entries(msgs)) {
    if (m?.role !== "assistant") continue
    const cl = m?.content_list ?? []
    if (!cl.some((c) => c?.phase === "answer")) continue
    let report = ""
    let refs = []
    let mdLink = null
    let pdfLink = null
    for (const c of cl) {
      if (!c || typeof c !== "object") continue
      if (c.phase === "answer") {
        report = c.content ?? ""
        refs = c.extra?.deep_research?.references ?? []
      }
      if (c.phase === "PdfMdGen") {
        mdLink = c.extra?.deep_research?.md?.link ?? null
        pdfLink = c.extra?.deep_research?.pdf?.link ?? null
      }
    }
    return { message_id: mid, report, references: refs, md_link: mdLink, pdf_link: pdfLink }
  }
  return {}
}

// --- Chromium boot ------------------------------------------------------------
function findChromium() {
  const root = `${process.env.HOME}/.cache/ms-playwright`
  if (existsSync(root)) {
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith("chromium-")) continue
      const bin = `${root}/${dir}/chrome-linux/chrome`
      if (existsSync(bin)) return bin
    }
  }
  return null
}

async function bootPod() {
  const bin = findChromium()
  if (!bin) fail(500, "chromium binary not found (playwright install failed?)")
  log("launching chromium:", bin)
  const child = spawn(bin, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=" + CDP_PORT,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    "https://chat.qwen.ai/",
  ], { stdio: "ignore" })
  child.on("exit", (code) => log("chromium exited:", code))
  for (let i = 0; i < 30; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
      if (v?.Browser) { log("CDP up:", v.Browser); return }
    } catch {}
    await sleep(1000)
  }
  fail(500, "CDP never came up on port " + CDP_PORT)
}

async function loginPod() {
  // Inject the JWT into the page's localStorage, reload, then prove the
  // session is real by creating a chat in-origin (this ALSO proves the WAF
  // accepts the runner's Azure IP for in-page fetch — the whole spike bet).
  for (let i = 0; i < 20; i++) {
    const href = await cdpEval("location.href").catch(() => null)
    if (String(href ?? "").startsWith("https://chat.qwen.ai")) break
    await sleep(2000)
  }
  await cdpEval(`localStorage.setItem('token', ${JSON.stringify(token)}); 'set'`)
  await cdpEval("location.reload(); 'reloading'")
  await sleep(6000)
  const href = await cdpEval("location.href").catch(() => null)
  log("page:", String(href ?? "").slice(0, 80))
  try {
    const chatId = await createChat()
    log("login verified, chat created:", chatId)
    return chatId
  } catch (e) {
    if (e.status === 401) fail(401, "session invalid — JWT expired (re-harvest the account, gh secret set)", { hint: "gh secret set QWEN_JWT_" + accountIndex })
    if (e.status === 403) fail(403, "WAF punish page from runner IP — Azure IPs blocked; fallback needed (CN route / VPS)")
    fail(e.status || 502, `login probe failed: ${e.message}`)
  }
}

async function downloadTo(url, destPath) {
  const r = await fetch(url, { headers: { Accept: "*/*" } })
  if (!r.ok) throw new Error(`download HTTP ${r.status} for ${destPath}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length === 0) throw new Error(`download 0 bytes for ${destPath}`)
  writeFileSync(destPath, buf)
  return buf.length
}

// --- Modes ---------------------------------------------------------------------
async function runSpike() {
  const chatId = await loginPod()
  const j = await qwenApi(`/api/v2/chat/completions?chat_id=${chatId}`, completionsBody(chatId, [userMessage("Reply with exactly: SPIKE-OK")]), "POST", 120000)
  const sse = String(j && typeof j === "object" ? JSON.stringify(j) : j)
  const ok = sse.includes("SPIKE-OK") || sse.includes('"content"')
  const result = {
    ok, status: ok ? "SPIKE-PASS" : "SPIKE-WEAK",
    account_index: accountIndex,
    waf: "in-origin fetch accepted from runner IP",
    login: "verified via chats/new",
    chat_completion: ok ? "stream received" : "no content in stream",
    elapsed_sec: Math.round((Date.now() - t0) / 1000),
  }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(`${OUT_DIR}/result.json`, JSON.stringify(result, null, 2))
  log("SPIKE RESULT:", JSON.stringify(result))
  if (!ok) process.exit(1)
}

async function runResearch() {
  try {
    await loginPod()
    let content = topic
    if (focus) content += `\nFocus: ${focus}`
    if (audience) content += `\nAudience: ${audience}`
    const chatId = await createChat()
    log("research chat:", chatId)
    // The completions stream returns the ResearchNotice after 2-8 min; the
    // report is generated in the background and collected via the poll loop.
    const noticeBudget = Math.min(maxWaitMs + 180000, 45 * 60 * 1000)
    await qwenApi(`/api/v2/chat/completions?chat_id=${chatId}`, completionsBody(chatId, [deepResearchMessage(content)]), "POST", noticeBudget)
    log("notice phase done — polling for the report")
    const deadline = Date.now() + maxWaitMs
    let report = {}
    let pollFails = 0
    while (Date.now() < deadline) {
      await sleep(15000)
      try {
        const chatJson = await qwenApi(`/api/v2/chats/${chatId}?direction=up&limit=10`, {}, "GET", 90000)
        report = extractResearchReport(chatJson)
        pollFails = 0
        if (report.report) break
      } catch {
        pollFails += 1
        log(`poll fail ${pollFails}/3`)
        if (pollFails >= 3) throw Object.assign(new Error("CDP/session lost mid-run (3 consecutive poll failures)"), { status: 502 })
      }
    }
    if (!report.report) fail(504, `no report within max_wait_seconds (${maxWaitMs / 1000}s) — empty report is never trusted`)
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(`${OUT_DIR}/report.md`, report.report)
    let mdBytes = Buffer.byteLength(report.report)
    let mdLink = null
    if (report.md_link) {
      try { mdBytes = await downloadTo(report.md_link, `${OUT_DIR}/report.md`); mdLink = "downloaded" }
      catch (e) { log("md link download failed (kept extracted text):", e.message) }
    }
    let pdfBytes = 0
    if (report.pdf_link) {
      try { pdfBytes = await downloadTo(report.pdf_link, `${OUT_DIR}/report.pdf`) }
      catch (e) { log("pdf link download failed:", e.message) }
    }
    const result = {
      ok: true,
      status: "DONE",
      mode,
      account_index: accountIndex,
      chat_id: chatId,
      message_id: report.message_id ?? null,
      references_count: (report.references ?? []).length,
      report_chars: report.report.length,
      md_bytes: mdBytes,
      pdf_bytes: pdfBytes,
      md_link: mdLink,
      elapsed_sec: Math.round((Date.now() - t0) / 1000),
    }
    writeFileSync(`${OUT_DIR}/result.json`, JSON.stringify(result, null, 2))
    log("DONE:", JSON.stringify(result))
  } catch (e) {
    fail(e.status || 502, e.message)
  }
}

if (mode === "spike") await runSpike()
else await runResearch()