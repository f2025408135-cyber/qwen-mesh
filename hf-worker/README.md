# HF free compute node — qwen-mesh-agent Space (WORKING 2026-09-02)

Outsource agentic compute to Hugging Face Spaces **free tier — ZeroGPU**:
**NVIDIA RTX PRO 6000 Blackwell (free GPU)** + CPU. Fully verified live.

## Status — VERIFIED WORKING

- Account: `oxmoiz` (HF access token stored LOCALLY in `F:\qwenmesh\accounts.json` — never commit it)
- Space: `oxmoiz/qwen-mesh-agent` (private, Gradio 6.26, ZeroGPU)
  https://huggingface.co/spaces/oxmoiz/qwen-mesh-agent
- Verified: `print(2+3)` -> 5; pi 5M iters -> 3.141592 in 1.6s;
  GPU probe -> NVIDIA RTX PRO 6000 Blackwell MIG 2g.48gb
- `hf-worker/app.py` = the worker (in-process exec, @spaces.GPU entrypoint)
- `hf-worker/hf-run.ps1` = local client (POST task, poll result)

## IMPORTANT: private spaces need a SIGNED URL

ZeroGPU private spaces return 404 without the `__sign` token (that's why
direct requests failed). To call the app:

1. Open `https://huggingface.co/spaces/oxmoiz/qwen-mesh-agent` in the logged-in
   Opera (:9223 CDP) -> the App tab embeds the space in an iframe with
   `?__sign=...`.
2. Extract the sign: `node` one-liner reading `document.querySelector('iframe').src`
   (see hf-run.ps1 - it reads `%TEMP%\opencode\hf-sig.txt`).
3. Call:
   - POST `https://oxmoiz-qwen-mesh-agent.hf.space/gradio_api/call/run_task?__sign=<sig>`
     body `{"data": ["<task_json>"], "event_data": null}` -> `{"event_id": "..."}`
   - GET `.../gradio_api/call/run_task/<event_id>?__sign=<sig>` -> `event: complete`
     `data: ["{\"ok\": true, \"stdout\": \"...\", \"elapsed\": ...}"]`

Task JSON: `{"script": "<python code>"}` (in-process exec, ZeroGPU-safe) or
`{"gpu": true}` (GPU probe). Shell commands via subprocess are DISABLED on
ZeroGPU (event-loop deadlock) - use in-process python only.

## What was learned (painful, 2026-09-02)

1. HF Spaces free tier: **ZeroGPU is the only free hardware** for new spaces
   (CPU-basic creation/downgrade requires PRO - 402 without it).
2. ZeroGPU requires `@spaces.GPU` on >=1 function ("No @spaces.GPU function
   detected" error otherwise).
3. HF's ZeroGPU base image FORCES `gradio==6.26.0` + `spaces==0.51.1` - do NOT
   pin gradio in requirements.txt (build conflict).
4. Gradio 6 API = `/gradio_api/call/<fn>` queue protocol (NOT `/run/predict`).
5. No `subprocess` inside @spaces.GPU (asyncio crash) - use in-process exec().
6. ASCII-only source (HF runtime charset is charmap on some paths).
7. Private spaces need the signed iframe URL - direct requests 404.
8. ZeroGPU sleeps on idle; first request wakes it (~10-30s).