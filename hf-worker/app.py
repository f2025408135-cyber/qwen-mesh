# app.py - qwen-mesh-agent Space worker (free HF ZeroGPU compute node).
# Standard HF Spaces pattern: define the Gradio app as `demo`, launch it.
# ZeroGPU requires @spaces.GPU on at least one function.
import json
import sys
import os
import traceback
import time

import gradio as gr
import spaces

MAX_RUN_SECONDS = int(os.environ.get("MAX_RUN_SECONDS", "180"))


def _exec_python(code: str) -> dict:
    """Run python code in-process, capturing stdout. Used for CPU tasks."""
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
        return json.dumps({"gpu": torch.cuda.is_available(), "name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none"})
    except Exception as e:
        return json.dumps({"gpu": False, "error": str(e)})


def run_task(task_json: str) -> str:
    """Execute a task (JSON) inside the Space. In-process only (ZeroGPU-safe)."""
    t0 = time.time()
    try:
        task = json.loads(task_json or "{}")
    except Exception as e:
        return json.dumps({"ok": False, "error": "bad json: " + str(e)})
    try:
        if task.get("gpu"):
            return json.dumps({"ok": True, "result": json.loads(_gpu_probe()), "elapsed": round(time.time() - t0, 2)})
        if "script" in task:
            r = _exec_python(task["script"])
            r["elapsed"] = round(time.time() - t0, 2)
            return json.dumps(r)
        return json.dumps({"ok": True, "note": "no script/gpu - space is alive",
                           "python": sys.version, "elapsed": round(time.time() - t0, 2)})
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc()[-3000:]})


def greet(task_json: str) -> str:
    return run_task(task_json)


demo = gr.Interface(
    fn=run_task,
    inputs=gr.Textbox(
        label='task JSON ({"script": "print(1+1)"} or {"gpu": true})',
        lines=4, value='{"script": "print(1+1)"}',
    ),
    outputs=gr.Textbox(label="result", lines=12),
    title="qwen-mesh-agent worker",
    description="Free HF compute node. POST /run/predict with {\"data\": [task_json]}.",
)

demo.launch()