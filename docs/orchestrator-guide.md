# Qwen3.8-Max as your Orchestrator — full integration guide

Reverse-engineered 2026-09-02 from the live chat.qwen.ai protocol + the
freecode bridge (`F:\FREE CODE BY MOIZ\services\bridges\qwen`). All paths
below are field-verified on this machine.

## 0. What the 25-account mesh now gives you (all FREE)

Through the bridge `http://127.0.0.1:8894` (OpenAI-shaped API), every JWT
account (indexes 1-25) can serve:

| Capability | Endpoint | Verified | Notes |
|---|---|---|---|
| Chat completions (OpenAI shape, streaming, thinking) | `POST /v1/chat/completions` | ✅ | models: `qwen3.8-max`, `qwen3.7-max`, `qwen3-coder-plus`, ... |
| **Tool calling (full agent loops)** | `POST /v1/chat/completions` + `tools` | ✅ 2026-09-02 | bracket protocol; parallel calls; tool-result loop works |
| Web-search grounded answers | `POST /features/web_search` | ✅ | `route=global` on JWT accounts |
| Deep research (Advanced, 100+ refs) | `POST /features/deep_research` | ✅ matured accts | research_mode:"advance" |
| Web app generation | `POST /features/web_dev` | ⚠️ CN tickets only | needs tongyi_sso_ticket |
| Image generation | `POST /features/image_gen` | ⚠️ CN tickets only | returns prompt, not binary |

Load-balancing: the bridge rotates accounts LRU + failover, so 25 accounts =
burst tolerance + parallel routes.

## 1. Qwen3.8-Max as the orchestrator brain — the best way

### 1.1 Make opencode itself use it (1-line config)

The bridge is OpenAI-compatible, so opencode can treat it as a provider.
Add to `C:\Users\hp\.config\opencode\opencode.json` → `provider`:

```jsonc
"qwenmesh": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "Qwen Mesh (25 free accounts)",
  "options": {
    "baseURL": "http://127.0.0.1:8894/v1",
    "apiKey": "qwen-mesh-local"   // bridge ignores it; any value works
  },
  "models": {
    "qwen3.8-max": {
      "name": "Qwen3.8 Max (mesh)",
      "reasoning": true,
      "tool_call": true,
      "limit": { "context": 1000000, "output": 65536 }
    }
  }
}
```

Then `opencode --model qwenmesh/qwen3.8-max` (or set `"model"` in config).
Qwen3.8-Max then drives opencode's full agent loop: plan → bash/edit/read
tools → review → commit — with zero API cost, on the 25-account pool.

### 1.2 The orchestrator-without-files pattern (what IT should/shouldn't do)

**Limitations (do NOT fight them):**
- Cannot read local files or run shell directly. It ONLY has the tools you
  give it (via the bridge: chat/web_search/deep_research/your custom tools).
- No attachments in the plain chat API (files need the app UI).
- Rate limits per account (429) — the bridge spaces requests.

**What it SHOULD do (optimal division of labor):**

```
Qwen3.8-Max (planner/orchestrator — pure reasoning, ~0 local RAM)
  │  tool_calls → your local executor tools:
  ├─ read_file / write_file / run_command   (you implement, run on THIS PC)
  ├─ web_search                            (bridge feature)
  ├─ deep_research                         (bridge feature, remote compute)
  └─ call_sub_agent(topic)                 (fan-out to other models)
```

Concrete recipe — the ORCHESTRATOR PROMPT (proven pattern):
```
You are the orchestrator of an autonomous research system. You cannot read
files or run commands — sub-agents DO that. Your job:
1. Decompose the mission into ≤5 independent tasks.
2. For each task emit ONE tool call: sub_agent({"task": "<fully-specified>",
   "required_output": "<exact deliverable>", "acceptance": "<check>"}).
3. After results return, synthesize the final report with numbered references.
Rules: never claim a file exists; never invent tool output; if a sub-agent
fails, re-dispatch ONCE with the failure in the task text.
```

### 1.3 Delegation (fan-out) pattern — the killer feature

Qwen orchestration + DeepSeek/other executors, all through tools:

```json
tools: [
  { "function": { "name": "sub_agent",
      "description": "Run a scoped task on an executor model. Returns the executor's final output text.",
      "parameters": { "type":"object",
        "properties": { "task": {"type":"string"}, "required_output": {"type":"string"} },
        "required": ["task"] } } },
  { "function": { "name": "deep_research",
      "description": "Run Qwen Advanced deep research on a topic. Returns a full sourced report.",
      "parameters": { "type":"object", "properties": { "topic": {"type":"string"} },
        "required": ["topic"] } } }
]
```

Your local driver (a small Node/PS loop) receives `tool_calls` from the
bridge, executes them (spawn opencode `run` for sub_agent / POST
`/features/deep_research` for research), and feeds `[TOOL_RESULT for call_id]`
back. Qwen then synthesizes. This is exactly how opencode's own agent loop
works — you get it free via the bridge.

## 2. Feature-by-feature outsourcing playbook

### 2.1 Deep research (already integrated — the flagship)
`POST /features/deep_research {topic, focus?, audience?, max_wait_seconds?}`
→ full sourced report (100+ refs), compute 100% on Qwen side. The hybrid
mesh (local fire → GitHub collect) makes even the polling free and remote.
Use for: literature reviews, market research, competitive analysis, any
"breadth + sources" task.

### 2.2 Web search (grounded Q&A)
`POST /features/web_search {query}` → answer grounded in live search.
Use for: current-events checks, price checks, quick fact-finding — cheaper
and faster than deep research.

### 2.3 Chat completions with tools (orchestrator loop)
`POST /v1/chat/completions` (stream or not) with `tools`.
Use for: planning, decomposition, synthesis, JSON protocol work, state
machines — the "brain" role.

### 2.4 Web app generation (CN tickets needed)
`POST /features/web_dev {prompt, title?}` → single-file HTML app artifact.
Requires a CN tongyi_sso_ticket account (upstream.js protocol). If you later
harvest CN accounts, this becomes free app prototyping.

### 2.5 Image generation (CN tickets needed)
`POST /features/image_gen {prompt, size?}` → returns an optimized
image_prompt (the web tier streams text prompts, not binaries). Wire the
prompt into a real image API (DashScope wanx / pollinations / local SD) for
the actual image.

## 3. What I implemented (2026-09-02, verified)

- **Global-path tool calling** (`global.js` + `server.js`): JWT accounts now
  run the full bracket-protocol tool loop (chat.js), not just text chat.
  Verified: `tool_calls: [{name:"weather", arguments:'{"city":"Lahore"}'}]`
  → tool result → final grounded answer. Qwen3.8-Max is now a real
  orchestrator on all 25 free accounts.
- **web_search on global accounts** verified (route=global, grounded answer).
- **Orchestrator config recipe** for opencode (section 1.1).

## 4. Hardware/load guidance (THIS machine)

- Bridge itself: ~150 MB idle. Pods: launch only what you need (cap 2 for
  chat/tools; deep research hybrid uses 1 pod briefly).
- Keep `free RAM ≥ 1.5 GB` (AGENTS.md). Close browsers before big waves.
- Rate limits: the bridge paces requests; space deep-research runs ≥60 s.

## 5. Next steps (pick any)

1. Add the `qwenmesh` provider to opencode.json and use Qwen3.8-Max as a
   planning agent (`/model` switch) — zero cost orchestrator.
2. Build the local executor loop (node) that turns Qwen tool_calls into real
   sub_agent runs (fan-out) — the "Qwen brain, DeepSeek hands" pattern.
3. Harvest CN tongyi_sso_ticket accounts to unlock web_dev + image_gen.
4. Wire a watcher that auto-launches pods 9301-9302 when the bridge reports
   cap=0, so the orchestrator is always ready.