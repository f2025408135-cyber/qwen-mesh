# qwen-mesh — remote Qwen deep-research pods on GitHub Actions

One `workflow_dispatch` = one headless chromium pod = one logged-in Qwen account =
one deep research. Fire N dispatches with distinct `account_index` (1-5) for a
true N-way parallel wave. Runs on GitHub's runners — zero local RAM.

## Protocol

Ported byte-for-byte from `services/bridges/qwen/src/global.js` (verified live
2026-08-11): JWT → `localStorage.token` → CDP in-origin fetch (WAF-safe) →
`chat_type: "deep_research"` + `research_mode: "advance"` → notice stream →
poll `GET /api/v2/chats/<id>?direction=up&limit=10` → answer phase + refs +
`PdfMdGen` md/pdf links → artifact.

## Usage (agent path — one PAT with Actions:write)

```powershell
# single research
gh workflow run deep-research.yml -R f2025408135-cyber/qwen-mesh `
  -f topic="<scoping-template topic>" -f account_index=1

# watch + collect
$run = gh run list -R f2025408135-cyber/qwen-mesh --workflow deep-research -L 1 --json databaseId -q '.[0].databaseId'
gh run watch $run -R f2025408135-cyber/qwen-mesh
gh run download $run -R f2025408135-cyber/qwen-mesh -n research-$run -D out\
```

Inputs: `topic` (required — use the scoping template), `focus`, `audience`,
`max_wait_seconds` (default 1500), `account_index` (1-5), `mode`
(`research` | `spike`).

Concurrency: runs sharing an `account_index` queue behind each other
(`qwen-account-<n>` group) — never double-fires one JWT. Distinct indices run
in parallel (free plan allows 20 concurrent jobs).

## Secrets

`QWEN_JWT_1..5` — chat.qwen.ai JWTs (encrypted, write-only, auto-masked in
logs). Rotation: re-harvest locally, then `gh secret set QWEN_JWT_<n>`.
Never commit a JWT — the repo is public and artifacts/run inputs are visible
by design (topics in → reports out; credentials never).

## Spike

`mode: spike` = login probe + WAF verdict + one chat completion, no research.
Use it to re-verify the runner IP is accepted after long pauses.

## Failure semantics (same doctrine as the local mesh)

| exit/symptom | meaning | fix |
|---|---|---|
| 401 | JWT expired | re-harvest → `gh secret set` |
| 403 | WAF punish from Azure IP | CN plain-HTTP route or VPS fallback |
| 429 | per-account burst | space runs; retry later |
| 504 empty report | still running / cap hit | retry with higher `max_wait_seconds`; never trust a 200-with-empty-report |
| 502 CDP/session lost | pod died mid-run | retry on another account_index |