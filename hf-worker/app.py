# app.py - qwen-mesh-agent Space worker (free HF ZeroGPU compute node).
# Outsource agentic compute to Hugging Face Spaces free tier.
# ZeroGPU: free Nvidia GPU runtime - requires @spaces.GPU on >=1 function.
# 24/7 pattern: pull-based - the keep-alive cron pings every 10h AND can post
# queued agent tasks; state is passed in the task JSON (no persistent disk).
import json
import sys
import os
import subprocess
import traceback
import time
import threading

import gradio as gr
import spaces

MAX_RUN_SECONDS = int(os.environ.get("MAX_RUN_SECONDS", "180"))
HERMES_ROOT = os.environ.get("HERMES_ROOT", os.path.expanduser("~/.hermes-agent"))
HERMES_BIN = os.path.join(HERMES_ROOT, "bin", "hermes")
_hermes_lock = threading.Lock()

# --- codex + pi agent swarm (1 codex orchestrator under 5 pi rust workers) ---
AGENT_BIN = os.path.expanduser("~/.agent-bin")
CODEX_BIN = os.path.join(AGENT_BIN, "codex")
PI_BIN = os.path.join(AGENT_BIN, "pi")
CODEX_HOME = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex-space"))
PI_HOME = os.environ.get("PI_HOME", os.path.expanduser("~/.pi-space"))
SWARM_ROOT = os.path.expanduser("~/swarm")
CODEX_VERSION = "rust-v0.92.0"  # last era with wire_api="chat" (removed Feb 2026, PR #10157)
CODEX_URL = f"https://github.com/openai/codex/releases/download/{CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz"
PI_URL = "https://github.com/badlogic/pi-mono/releases/latest/download/pi-linux-x64.tar.gz"
_swarm_lock = threading.Lock()


def _gemini_keys() -> list:
    """Rotating key pool: GEMINI_KEYS secret (csv) falls back to GEMINI_API_KEY/LLM_KEY."""
    raw = os.environ.get("GEMINI_KEYS", "") or os.environ.get("GEMINI_API_KEY", "") \
        or os.environ.get("LLM_KEY", "")
    return [k.strip() for k in raw.split(",") if k.strip()] or [""]


def _ensure_swarm_binaries(log) -> None:
    """Download codex + pi linux binaries once per container (cached in FS)."""
    import glob as _glob
    global PI_BIN
    os.makedirs(AGENT_BIN, exist_ok=True)
    with _swarm_lock:
        stamp = os.path.join(AGENT_BIN, "codex-version.txt")
        need_codex = not os.path.exists(CODEX_BIN)
        if os.path.exists(stamp):
            with open(stamp) as f:
                need_codex = need_codex or f.read().strip() != CODEX_VERSION
        if need_codex:
            log.append(f"codex: downloading {CODEX_VERSION}...")
            d = os.path.join(AGENT_BIN, "_codex")
            os.makedirs(d, exist_ok=True)
            r = subprocess.run(["bash", "-c", f"curl -sL '{CODEX_URL}' | tar -xz -C '{d}'"],
                               capture_output=True, text=True, timeout=300)
            hits = _glob.glob(os.path.join(d, "**", "codex*"), recursive=True)
            hits = [h for h in hits if os.path.isfile(h)]
            if not hits:
                raise RuntimeError("codex dl failed: " + (r.stderr or "")[-200:])
            shutil_move(hits[0], CODEX_BIN)
            os.chmod(CODEX_BIN, 0o755)
            with open(stamp, "w") as f:
                f.write(CODEX_VERSION)
            log.append("codex: installed")
        if not os.path.exists(PI_BIN):
            log.append("pi: downloading release binary...")
            d = os.path.join(AGENT_BIN, "_pi")
            import shutil as _sh
            _sh.rmtree(d, ignore_errors=True)
            os.makedirs(d, exist_ok=True)
            r = subprocess.run(["bash", "-c", f"curl -sL '{PI_URL}' | tar -xz -C '{d}'"],
                               capture_output=True, text=True, timeout=300)
            # tarball layout: pi/pi (bun exe) + pi/theme/*.json siblings -
            # keep the tree intact (bun exe resolves theme/ relative to itself)
            hits = [h for h in _glob.glob(os.path.join(d, "**", "pi"), recursive=True)
                    if os.path.isfile(h)]
            if not hits:
                raise RuntimeError("pi dl failed: " + (r.stderr or "")[-200:])
            os.chmod(hits[0], 0o755)
            PI_BIN = hits[0]
            log.append("pi: installed at " + hits[0])
        # codex config: speaks Responses API to local LiteLLM bridge -> native gemini
        # (Gemini's OpenAI-compat endpoint rejects codex tool schemas; LiteLLM
        # translates properly. chat wire was removed from codex in Feb 2026.)
        os.makedirs(CODEX_HOME, exist_ok=True)
        cfg = os.path.join(CODEX_HOME, "config.toml")
        with open(cfg, "w") as f:
            f.write('model_provider = "litellm"\n'
                    'model = "gemini-2.5-flash"\n'
                    'approval_policy = "never"\n'
                    'sandbox_mode = "danger-full-access"\n'
                    '[model_providers.litellm]\n'
                    'name = "LiteLLM bridge -> native gemini"\n'
                    'base_url = "http://127.0.0.1:4000/v1"\n'
                    'env_key = "GEMINI_API_KEY"\n'
                    'wire_api = "responses"\n')


LITELLM_YAML = os.path.join(AGENT_BIN, "litellm.yaml")
_litellm_proc = None


def _ensure_litellm(log) -> None:
    """Start the LiteLLM responses->gemini bridge on 127.0.0.1:4000 (cached)."""
    global _litellm_proc
    import urllib.request as _u
    with _swarm_lock:
        alive = False
        if _litellm_proc is not None and _litellm_proc.poll() is None:
            alive = True
        else:
            try:
                with _u.urlopen("http://127.0.0.1:4000/health/liveliness", timeout=3) as r:
                    alive = r.status == 200
            except Exception:
                alive = False
        if alive:
            return
        # ensure dependency (proxy extra needed for the /v1/responses server)
        try:
            import backoff  # noqa: F401  (proxy-only dep)
            import litellm  # noqa: F401
        except Exception:
            log.append("litellm: pip installing proxy extra...")
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "litellm[proxy]"],
                           capture_output=True, text=True, timeout=900)
        os.makedirs(AGENT_BIN, exist_ok=True)
        with open(LITELLM_YAML, "w") as f:
            f.write('model_list:\n'
                    '  - model_name: gemini-2.5-flash\n'
                    '    litellm_params:\n'
                    '      model: gemini/gemini-2.5-flash\n'
                    '      api_key: os.environ/GEMINI_API_KEY\n')
        env = dict(os.environ)
        env["GEMINI_API_KEY"] = _gemini_keys()[0]
        import shutil as _shutil
        litellm_exe = _shutil.which("litellm") or "/usr/local/bin/litellm"
        logf = open(os.path.join(AGENT_BIN, "litellm.log"), "w")
        _litellm_proc = subprocess.Popen(
            [litellm_exe, "--config", LITELLM_YAML, "--port", "4000"],
            stdout=logf, stderr=subprocess.STDOUT, env=env,
            start_new_session=True)
        # wait for readiness
        deadline = time.time() + 120
        while time.time() < deadline:
            try:
                with _u.urlopen("http://127.0.0.1:4000/health/liveliness", timeout=3) as r:
                    if r.status == 200:
                        log.append("litellm: bridge ready on :4000")
                        return
            except Exception:
                time.sleep(2)
        raise RuntimeError("litellm bridge did not become ready in 120s")


def shutil_move(src: str, dst: str) -> None:
    import shutil
    shutil.move(src, dst)


def run_codex(prompt: str, timeout: int, log: list) -> dict:
    """One-shot codex exec (orchestrator). Speaks Responses API via LiteLLM."""
    _ensure_swarm_binaries(log)
    _ensure_litellm(log)
    out = os.path.join(SWARM_ROOT, "codex-last.txt")
    os.makedirs(SWARM_ROOT, exist_ok=True)
    env = dict(os.environ)
    env.update({"CODEX_HOME": CODEX_HOME, "GEMINI_API_KEY": _gemini_keys()[0]})
    args = [CODEX_BIN, "exec", "--skip-git-repo-check", "--output-last-message", out, prompt]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env,
                           cwd=SWARM_ROOT)
        last = ""
        if os.path.exists(out):
            with open(out) as f:
                last = f.read()
        return {"ok": r.returncode == 0, "stdout": (last or r.stdout or "")[-8000:],
                "stderr": (r.stderr or "")[-1500:], "exit": r.returncode}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"codex timeout > {timeout}s"}


def run_pi(prompt: str, timeout: int, api_key: str, workdir: str, log: list) -> dict:
    """One-shot pi (rust) worker in print mode."""
    _ensure_swarm_binaries(log)
    os.makedirs(workdir, exist_ok=True)
    env = dict(os.environ)
    env.update({"HOME": os.path.expanduser("~"), "PI_HOME": PI_HOME})
    args = [PI_BIN, "--provider", "google", "--model", "gemini-2.5-flash",
            "--api-key", api_key, "--mode", "text", "--no-session", "-p", prompt]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env,
                           cwd=workdir)
        return {"ok": r.returncode == 0, "stdout": (r.stdout or "")[-6000:],
                "stderr": (r.stderr or "")[-1500:], "exit": r.returncode}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"pi timeout > {timeout}s"}


def run_swarm(sconf: dict, t0: float) -> dict:
    """1 codex orchestrator -> N pi rust workers -> codex review."""
    log = []
    task = str(sconf.get("task", "")).strip()
    n_workers = min(max(int(sconf.get("workers", 5)), 1), 8)
    w_timeout = int(sconf.get("worker_timeout", 240))
    phase_timeout = int(sconf.get("phase_timeout", 240))
    if not task:
        return {"ok": False, "error": "swarm.task required"}
    keys = _gemini_keys()
    os.makedirs(SWARM_ROOT, exist_ok=True)
    for i in range(n_workers):
        os.makedirs(os.path.join(SWARM_ROOT, f"worker-{i}"), exist_ok=True)

    # Phase 1: codex decomposes into JSON array of subtasks
    plan_prompt = (
        "You are the orchestrator. Decompose this task into exactly "
        f"{n_workers} INDEPENDENT subtasks. Reply with ONLY a JSON array of "
        f"{n_workers} strings, no prose, no code fences. Task: {task}")
    p1 = run_codex(plan_prompt, phase_timeout, log)
    plan = p1.get("stdout", "")
    subtasks = []
    import re as _re
    m = _re.search(r"\[[\s\S]*\]", plan)
    if m:
        try:
            subtasks = json.loads(m.group(0))
        except Exception:
            subtasks = []
    if not isinstance(subtasks, list) or not subtasks:
        subtasks = [task]
        log.append("plan: codex JSON parse failed -> single task fallback")
    subtasks = (subtasks + [task] * n_workers)[:n_workers]
    log.append(f"plan: {len(subtasks)} subtasks")

    # Phase 2: pi workers in parallel (staggered 8s, rotating keys)
    results = [None] * len(subtasks)
    def _worker(i, st):
        key = keys[i % len(keys)]
        if len(keys) > 1:
            time.sleep(8 * (i % len(keys)))  # spread per-key RPM
        results[i] = run_pi(st, w_timeout, key, os.path.join(SWARM_ROOT, f"worker-{i}"), log)
    threads = [threading.Thread(target=_worker, args=(i, st)) for i, st in enumerate(subtasks)]
    for t in threads: t.start()
    for t in threads: t.join()
    log.append(f"workers: {sum(1 for r in results if r and r.get('ok'))}/{len(subtasks)} ok")

    # Phase 3: codex reviews + merges
    merged = "\n\n".join(f"--- worker-{i} ---\n{r.get('stdout', '') if r else '(crashed)'}"
                         for i, r in enumerate(results))
    review_prompt = ("Merge the following worker outputs into one final deliverable "
                     f"for the task: {task}\n\n{merged}\n\nReply with the merged result only.")
    p3 = run_codex(review_prompt, phase_timeout, log)
    return {"ok": all(r.get("ok") for r in results if r) and p3.get("ok", False),
            "subtasks": subtasks, "worker_results": results,
            "final": p3.get("stdout", "")[-8000:], "bootstrap_log": log,
            "elapsed": round(time.time() - t0, 2)}


def _exec_python(code: str) -> dict:
    """Run python code in-process, capturing stdout (ZeroGPU-safe)."""
    import io
    import contextlib
    buf = io.StringIO()
    err = ""
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()) as eb:
            exec(compile(code, "<task>", "exec"), {"__name__": "__main__"})
        err = eb.getvalue()
    except Exception:
        err += "\n" + traceback.format_exc()
    return {"ok": not err.strip() or "Traceback" not in err, "stdout": buf.getvalue()[-8000:], "stderr": err[-4000:]}


def _hermes_installed() -> bool:
    if not os.path.exists(HERMES_BIN):
        return False
    try:
        py = os.path.join(HERMES_ROOT, "venv", "bin", "python")
        if not os.path.exists(py):
            return False
        r = subprocess.run([py, "-c", "import hermes_cli; print('ok')"],
                           capture_output=True, text=True, timeout=30)
        return r.returncode == 0
    except Exception:
        return False


def _install_hermes(log) -> None:
    """Clone + install Hermes Agent CLI (NousResearch) into ~/.hermes-agent.
    Subprocess is safe here (NOT inside @spaces.GPU). Cached in the container
    FS - survives as long as the space doesn't restart (keep-alive prevents).
    Verifies the module imports; raises if the install is broken."""
    import shutil
    log.append("bootstrap: cloning hermes-agent...")
    os.makedirs(HERMES_ROOT, exist_ok=True)
    src = os.path.join(HERMES_ROOT, "src")
    if os.path.exists(src):
        shutil.rmtree(src, ignore_errors=True)
    r = subprocess.run(
        ["git", "clone", "--depth", "1", "https://github.com/NousResearch/hermes-agent.git", src],
        capture_output=True, text=True, timeout=300)
    log.append(f"clone: rc={r.returncode} {str(r.stderr or '')[-200:]}")
    if not os.path.exists(src):
        raise RuntimeError("hermes clone failed: " + str(r.stderr or "")[-300:])
    log.append("bootstrap: creating venv + installing deps...")
    venv = os.path.join(HERMES_ROOT, "venv")
    if os.path.exists(venv):
        shutil.rmtree(venv, ignore_errors=True)
    subprocess.run([sys.executable, "-m", "venv", venv],
                   capture_output=True, text=True, timeout=300)
    py = os.path.join(venv, "bin", "python")
    r1 = subprocess.run([py, "-m", "pip", "install", "-q", "--upgrade", "pip"],
                        capture_output=True, text=True, timeout=300)
    log.append(f"pip-upgrade: rc={r1.returncode}")
    r1b = subprocess.run([py, "-m", "pip", "install", "-q", "setuptools", "wheel"],
                         capture_output=True, text=True, timeout=300)
    log.append(f"pip-builddeps: rc={r1b.returncode}")
    r2 = subprocess.run([py, "-m", "pip", "install", "-q", "-e", src, "--no-build-isolation"],
                        capture_output=True, text=True, timeout=900)
    log.append(f"pip-install: rc={r2.returncode} {str(r2.stderr or '')[-400:]}")
    r3 = subprocess.run([py, "-c", "import hermes_cli; print('ok')"],
                        capture_output=True, text=True, timeout=60)
    log.append(f"import-check: rc={r3.returncode} {str(r3.stdout or '')[:50]} {str(r3.stderr or '')[-300:]}")
    if r3.returncode != 0:
        # fallback: plain install (not editable) - some repos need this
        log.append("fallback: pip install (non-editable)...")
        r4 = subprocess.run([py, "-m", "pip", "install", "-q", src],
                            capture_output=True, text=True, timeout=900)
        log.append(f"pip-fallback: rc={r4.returncode} {str(r4.stderr or '')[-400:]}")
        r3 = subprocess.run([py, "-c", "import hermes_cli; print('ok')"],
                            capture_output=True, text=True, timeout=60)
        log.append(f"import-check2: rc={r3.returncode} {str(r3.stderr or '')[-300:]}")
    if r3.returncode != 0:
        raise RuntimeError("hermes_cli module did not import: " + str(r3.stderr or "")[-300:])
    os.makedirs(os.path.join(HERMES_ROOT, "bin"), exist_ok=True)
    with open(HERMES_BIN, "w") as f:
        f.write("#!/bin/bash\n")
        f.write(f'exec {py} -m hermes_cli.main "$@"\n')
    os.chmod(HERMES_BIN, 0o755)
    log.append("bootstrap: hermes installed + verified")


def run_hermes(hconf: dict, t0: float) -> dict:
    """Run a Hermes Agent CLI job. hconf = {"prompt", "timeout", "model"}.
    Uses the HF secret LLM_KEY (set in space settings) as the model API key.
    Covers: hermes run (one-shot), hermes memory, hermes skills, hermes cron.
    """
    import pathlib
    log = []
    cmd = hconf.get("cmd", "run")
    prompt = str(hconf.get("prompt", ""))
    timeout = int(hconf.get("timeout", 120))
    model = str(hconf.get("model", ""))
    provider = str(hconf.get("provider", ""))
    api_key = os.environ.get("LLM_KEY", "")
    api_base = os.environ.get("LLM_BASE_URL", "")
    api_provider = os.environ.get("LLM_PROVIDER", "openai")

    with _hermes_lock:
        if not _hermes_installed():
            try:
                _install_hermes(log)
            except Exception as e:
                return {"ok": False, "error": f"hermes install failed: {e}",
                        "bootstrap_log": log, "elapsed": round(time.time() - t0, 2)}
    if not api_key:
        return {"ok": False, "error": "LLM_KEY secret not set on the space (settings -> secrets)"}

    env = dict(os.environ)
    env.update({
        "OPENAI_API_KEY": api_key,
        "OPENAI_BASE_URL": api_base,
        "LLM_PROVIDER": api_provider,
        "HERMES_HOME": os.path.join(HERMES_ROOT, "home"),
    })
    # hermes 0.21 has a NATIVE gemini provider (agent/gemini_native_adapter.py) -
    # Google's OpenAI-compat endpoint 404s on hermes multi-turn, so the native
    # path is canonical. Key comes from GEMINI_API_KEY (falls back to LLM_KEY).
    if not env.get("GEMINI_API_KEY"):
        env["GEMINI_API_KEY"] = api_key
    if not env.get("GOOGLE_API_KEY"):
        env["GOOGLE_API_KEY"] = api_key
    if model:
        env["HERMES_MODEL"] = model

    args = [HERMES_BIN]
    if cmd == "run":
        # hermes 0.21: one-shot = `hermes -z "prompt" --cli` (no TUI)
        args += ["-z", prompt, "--cli"]
    elif cmd == "delegate":
        args += ["-z", prompt, "--cli", "-t", "delegate"]
    elif cmd in ("chat", "config", "secrets", "login", "auth", "setup", "doctor",
                 "sync", "backup", "status", "checkpoints", "curator", "journey",
                 "memory-graph", "tools", "computer-use", "mcp", "sessions",
                 "insights", "monitoring", "claw", "update", "uninstall", "acp",
                 "profile", "completion", "dashboard", "serve", "desktop", "gui",
                 "logs", "prompt-size", "import", "import-agent", "browser",
                 "worktree", "model", "moa", "fallback", "migrate", "gateway",
                 "proxy", "lsp", "whatsapp", "whatsapp-cloud", "slack", "send",
                 "logout", "pause", "resume", "webhook", "peer", "portal",
                 "kanban", "project", "hooks", "verify", "security", "approvals",
                 "dump", "debug", "console", "pairing", "bundles", "plugins",
                 "egress", "learning"):
        # subcommand passthrough: hermes <cmd> <args>
        args += [cmd] + prompt.split()
    else:
        # memory / skills / cron with sub-args
        args += [cmd] + prompt.split()

    if model:
        args += ["-m", model]
    if provider:
        args += ["--provider", provider]

    log.append("cmd: " + " ".join(args[:5]) + "...")
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout + 30, env=env,
                           cwd=os.path.expanduser("~"))
        return {
            "ok": r.returncode == 0,
            "stdout": (r.stdout or "")[-6000:],
            "stderr": (r.stderr or "")[-2000:],
            "exit": r.returncode,
            "bootstrap_log": log,
            "elapsed": round(time.time() - t0, 2),
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"hermes timeout > {timeout}s", "elapsed": round(time.time() - t0, 2)}
    except Exception as e:
        return {"ok": False, "error": str(e), "elapsed": round(time.time() - t0, 2)}


@spaces.GPU(duration=30)
def _gpu_probe() -> str:
    """ZeroGPU requires a @spaces.GPU entrypoint. Probe GPU availability.
    duration=30 keeps the quota cost tiny (sub-second real GPU use)."""
    try:
        import torch
        return json.dumps({"gpu": torch.cuda.is_available(),
                           "name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none"})
    except Exception as e:
        return json.dumps({"gpu": False, "error": str(e)})


def run_task(task_json: str) -> str:
    """Execute a task (JSON) inside the Space. In-process only (ZeroGPU-safe).

    Supported task shapes:
      {"gpu": true}                          -> GPU probe
      {"script": "<python code>"}            -> run inline python, return stdout
      {"agent": {"goal": "...", "steps": N,
                 "tools": {...}, "state": {...}}} -> run a bounded agent loop
      {"hermes": {"cmd": "run|memory|skills|cron|delegate",
                  "prompt": "...", "timeout": 120, "model": "..."}} -> Hermes CLI job
    """
    t0 = time.time()
    try:
        task = json.loads(task_json or "{}")
    except Exception as e:
        return json.dumps({"ok": False, "error": "bad json: " + str(e)})
    try:
        if task.get("gpu"):
            return json.dumps({"ok": True, "result": json.loads(_gpu_probe()),
                               "elapsed": round(time.time() - t0, 2)})
        if "swarm" in task:
            return json.dumps(run_swarm(task["swarm"], t0))
        if "codex" in task:
            _ensure_swarm_binaries([])
            r = run_codex(str(task["codex"].get("prompt", "")),
                          int(task["codex"].get("timeout", 240)), [])
            r["elapsed"] = round(time.time() - t0, 2)
            return json.dumps(r)
        if "pi" in task:
            _ensure_swarm_binaries([])
            keys = _gemini_keys()
            r = run_pi(str(task["pi"].get("prompt", "")),
                       int(task["pi"].get("timeout", 240)),
                       keys[0], os.path.join(SWARM_ROOT, "single-pi"), [])
            r["elapsed"] = round(time.time() - t0, 2)
            return json.dumps(r)
        if "agent" in task:
            return json.dumps(run_agent(task["agent"], t0))
        if "hermes" in task:
            return json.dumps(run_hermes(task["hermes"], t0))
        if "script" in task:
            r = _exec_python(task["script"])
            r["elapsed"] = round(time.time() - t0, 2)
            return json.dumps(r)
        return json.dumps({"ok": True, "note": "no script/agent/gpu - space is alive",
                           "python": sys.version, "elapsed": round(time.time() - t0, 2)})
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc()[-3000:]})


def run_agent(agent: dict, t0: float) -> dict:
    """Bounded 24/7-style agent loop. The space has NO persistent disk and
    sleeps on idle, so each invocation runs up to MAX_RUN_SECONDS of work and
    returns (state, done, next_work) - the caller resumes by posting state back.

    agent = {
      "goal": str,                 # the agent's mission
      "steps": int,                # max steps this invocation
      "state": {...},              # resume state (passed in/out)
      "worker": "<python code that takes state and returns {done, state, output}>"
    }
    """
    goal = str(agent.get("goal", ""))
    steps = int(agent.get("steps", 1))
    state = agent.get("state", {})
    worker_code = agent.get("worker", "")
    if not worker_code:
        return {"ok": False, "error": "agent.worker (python) required"}
    results = []
    done = False
    for i in range(max(1, steps)):
        if time.time() - t0 > MAX_RUN_SECONDS - 10:
            break
        # run the worker with the current state
        ns = {"__name__": "__main__", "state": state, "goal": goal,
              "time": time, "json": json}
        try:
            exec(compile(worker_code, "<agent-worker>", "exec"), ns)
        except Exception as e:
            results.append({"step": i, "error": str(e)})
            break
        state = ns.get("state", state)
        output = ns.get("output", "")
        results.append({"step": i, "output": output})
        if ns.get("done"):
            done = True
            break
    return {"ok": True, "done": done, "state": state, "steps_run": len(results),
            "results": results, "goal": goal,
            "elapsed": round(time.time() - t0, 2)}


with gr.Blocks(title="qwen-mesh-agent worker") as demo:
    gr.Markdown("# qwen-mesh-agent worker - free HF compute node")
    task_input = gr.Textbox(
        label='task JSON ({"script": "..."} | {"gpu": true} | {"agent": {...}} | {"hermes": {...}})',
        lines=4, value='{"script": "print(1+1)"}',
    )
    run_btn = gr.Button("Run")
    output = gr.Textbox(label="result", lines=12)
    run_btn.click(run_task, inputs=task_input, outputs=output, concurrency_limit=8)

# Zero a10g = 2 vCPU / 16GB RAM: ~4-5 parallel light hermes runs is realistic.
demo.queue(default_concurrency_limit=8).launch()