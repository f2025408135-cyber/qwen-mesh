# app.py - qwen-mesh-agent Space worker (free HF ZeroGPU compute node).
# Outsource agentic compute to Hugging Face Spaces free tier.
# ZeroGPU: free Nvidia GPU runtime - requires @spaces.GPU on >=1 function.
# 24/7 pattern: pull-based - the keep-alive cron pings every 10h AND can post
# queued agent tasks; state is passed in the task JSON (no persistent disk).
import json
import sys
import os
import traceback
import time

import gradio as gr
import spaces

MAX_RUN_SECONDS = int(os.environ.get("MAX_RUN_SECONDS", "180"))


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


@spaces.GPU
def _gpu_probe() -> str:
    """ZeroGPU requires a @spaces.GPU entrypoint. Probe GPU availability."""
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
        if "agent" in task:
            return json.dumps(run_agent(task["agent"], t0))
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
        label='task JSON ({"script": "print(1+1)"} | {"gpu": true} | {"agent": {...}})',
        lines=4, value='{"script": "print(1+1)"}',
    )
    run_btn = gr.Button("Run")
    output = gr.Textbox(label="result", lines=12)
    run_btn.click(run_task, inputs=task_input, outputs=output)

demo.queue().launch()