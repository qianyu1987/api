#!/usr/bin/env python3
"""Triage helper: classify one task description via the running observation console.

For agents (e.g. Codex) that want a quick task_type / needs_tools signal before
picking a tool or model. Stdlib only; no model loaded here.

Usage:
  python3 ask.py "把这段视频剪成 15 秒竖屏"
  echo "写一个 CSV 去重脚本" | python3 ask.py

Prints a one-line JSON summary. Exit codes: 0 ok, 2 console unreachable.
"""

from __future__ import annotations

import json
import sys
import urllib.request

CONSOLE = "http://127.0.0.1:19095/api/classify"


def main() -> int:
    if len(sys.argv) > 1:
        text = " ".join(sys.argv[1:]).strip()
    else:
        text = sys.stdin.read().strip()
    if not text or len(text) > 8000:
        print(json.dumps({"error": "text_required_1_to_8000_chars"}))
        return 1
    req = urllib.request.Request(
        CONSOLE, data=json.dumps({"text": text}).encode(),
        headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except OSError as exc:
        print(json.dumps({"error": "console_unreachable", "detail": str(exc)[:120]}))
        return 2
    if not data.get("ok"):
        print(json.dumps({"error": data.get("error"), "detail": data.get("detail")}))
        return 1
    answers = data["answers"]
    task = answers["task_type"]
    tools = answers["needs_tools"]
    top = sorted(task.get("probabilities", {}).items(), key=lambda kv: -kv[1])[:2]
    print(json.dumps({
        "task_type": task["choice"],
        "confidence": task.get("confidence"),
        "top2": [{"label": k, "p": v} for k, v in top],
        "needs_tools": float(tools["value"]) >= 0.5,
        "noul": tools["value"],
        "duration_ms": data["duration_ms"],
        "note": "observation signal only, not routing authority",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
