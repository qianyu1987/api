#!/usr/bin/env python3
"""Loopback-only web observation console for the Laya MLX shadow runtime.

Serves a dashboard that shows what the shadow pipeline is actually doing:
component liveness, live log tails, in-process classification with full
probability output, and the built-in evaluation set.

Loopback only. Never logs user prompt text. Never prints tokens.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

TOOLS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS_DIR))

DEFAULT_RUNTIME = Path("/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow")

STATE: dict[str, Any] = {
    "ready": False,
    "error": None,
    "load_ms": None,
    "started": time.time(),
}
MODEL: Any = None
MODEL_LOCK = threading.Lock()
CLASSIFY_LOCK = threading.Lock()  # shared MLX model: one inference at a time
LOG_FILES = {"supervisor": "supervisor.log", "transport": "transport.log"}
CLASSIFIER_PORT = 19091


def log_tail(path: Path, max_lines: int, tail_bytes: int = 512_000) -> list[dict]:
    if not path.is_file():
        return []
    try:
        size = path.stat().st_size
        with open(path, "rb") as handle:
            handle.seek(max(0, size - tail_bytes))
            chunk = handle.read()
        lines = chunk.decode("utf-8", "replace").splitlines()
        out = []
        for line in lines[-max_lines:]:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                out.append({"raw": line[:400]})
        return out
    except OSError:
        return []


def supervisor_running() -> bool:
    proc = subprocess.run(["pgrep", "-f", "transport_supervisor.py"],
                          capture_output=True, text=True)
    return proc.returncode == 0


def classifier_health() -> dict[str, Any]:
    payload: dict[str, Any] = {"up": False, "load_ms": None}
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{CLASSIFIER_PORT}/healthz", timeout=1.5
        ) as resp:
            data = json.loads(resp.read())
            payload["up"] = resp.status == 200 and data.get("ok") is True
            payload["load_ms"] = data.get("load_ms")
    except (OSError, ValueError):
        pass
    return payload


def model_meta(runtime: Path) -> dict[str, Any]:
    meta: dict[str, Any] = {"manifest": None, "mlx_config": None, "model_bytes": None}
    model_dir = runtime / "models"
    try:
        candidates = sorted(model_dir.glob("*/manifest.json")) if model_dir.is_dir() else []
        if candidates:
            manifest = json.loads(candidates[-1].read_text())
            meta["manifest"] = {
                "repository": manifest.get("repository"),
                "source": manifest.get("source"),
                "dtype": manifest.get("dtype"),
                "verified_tensors": manifest.get("verified_tensors"),
                "model_bytes": (manifest.get("files", {}).get("model.safetensors") or {}).get("bytes"),
            }
            mlxcfg = manifest["files"].get("mlx_config.json")
            cfg_path = candidates[-1].parent / "mlx_config.json"
            if cfg_path.is_file():
                meta["mlx_config"] = json.loads(cfg_path.read_text())
    except (OSError, ValueError, KeyError):
        pass
    return meta


def collect_status(runtime: Path) -> dict[str, Any]:
    supervisor_log = log_tail(runtime / "supervisor.log", 300)
    transport_log = log_tail(runtime / "transport.log", 300)
    last_supervisor = supervisor_log[-1] if supervisor_log else None
    last_transport = transport_log[-1] if transport_log else None
    transport_errors = [e for e in transport_log[-100:] if e.get("event") in ("transport_error", "transport_verification_failed")]
    return {
        "dashboard": {
            "ready": STATE["ready"],
            "load_error": STATE["error"],
            "model_load_ms": STATE["load_ms"],
            "uptime_s": round(time.time() - STATE["started"], 1),
        },
        "classifier_19091": classifier_health(),
        "supervisor": {
            "running": supervisor_running(),
            "last_event": last_supervisor,
        },
        "transport": {
            "last_event": last_transport,
            "recent_error_count": len(transport_errors),
            "last_error_ts": transport_errors[-1].get("ts") if transport_errors else None,
        },
        "model": model_meta(runtime),
    }


class Handler(BaseHTTPRequestHandler):
    server: "DashboardServer"

    def log_message(self, *args: Any) -> None:
        pass

    def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, status: HTTPStatus, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        runtime = self.server.runtime
        if self.path == "/":
            self.send_html(HTTPStatus.OK, self.server.html)
            return
        if self.path == "/api/status":
            self.send_json(HTTPStatus.OK, collect_status(runtime))
            return
        if self.path.startswith("/api/logs"):
            name = self.path.split("file=")[-1] if "file=" in self.path else ""
            if name not in LOG_FILES:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "unknown_file"})
                return
            lines = log_tail(runtime / LOG_FILES[name], 300)
            self.send_json(HTTPStatus.OK, {
                "file": name,
                "lines": lines,
                "total": len(lines),
                "mtime": (runtime / LOG_FILES[name]).stat().st_mtime if (runtime / LOG_FILES[name]).is_file() else None,
            })
            return
        if self.path == "/api/reports":
            reports = []
            for path in sorted(runtime.glob("*-report-*.json")):
                try:
                    data = json.loads(path.read_text())
                    reports.append({
                        "name": path.name,
                        "mtime": path.stat().st_mtime,
                        "sample_count": data.get("sample_count"),
                        "task_type_accuracy": data.get("task_type_accuracy"),
                        "needs_tools_accuracy": data.get("needs_tools_accuracy"),
                        "warm_latency_median_ms": data.get("warm_latency_median_ms"),
                        "dataset_kind": data.get("dataset_kind"),
                    })
                except (OSError, ValueError):
                    continue
            self.send_json(HTTPStatus.OK, {"reports": reports})
            return
        if self.path == "/api/model":
            self.send_json(HTTPStatus.OK, {"meta": model_meta(runtime), "ready": STATE["ready"]})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(min(max(length, 0), 64_000))
            payload = json.loads(raw or b"{}")
        except (ValueError, OSError):
            payload = {}
        if self.path == "/api/classify":
            text = payload.get("text") if isinstance(payload, dict) else None
            if not isinstance(text, str) or not text.strip() or len(text) > 8_000:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_text"})
                return
            if not STATE["ready"]:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE,
                               {"error": "model_not_ready", "detail": STATE["error"]})
                return
            with CLASSIFY_LOCK:
                started = time.perf_counter()
                try:
                    result = MODEL.predict(text, self.server.questions)
                except Exception as exc:  # never log prompt content
                    self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR,
                                   {"error": "inference_failed", "detail": str(exc)[:200]})
                    return
                duration_ms = round((time.perf_counter() - started) * 1000, 1)
            self.send_json(HTTPStatus.OK, {
                "ok": True,
                "mode": "shadow",
                "duration_ms": duration_ms,
                "answers": self.server.compact(result),
                "raw_answers": {
                    name: {
                        "confidence": v.get("confidence"),
                        "action_probability": (v.get("action") or {}).get("act_probability"),
                        **({"probabilities": v.get("probabilities")} if "probabilities" in v else {}),
                        **({"choice": v.get("choice")} if "choice" in v else {}),
                        **({"noul": v.get("noul")} if "noul" in v else {}),
                        **({"score": v.get("score")} if "score" in v else {}),
                    } for name, v in result.get("answers", {}).items()
                },
            })
            return
        if self.path == "/api/evaluate":
            if not STATE["ready"]:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "model_not_ready"})
                return
            all_cases = self.server.cases
            limit = payload.get("limit") if isinstance(payload, dict) else None
            if isinstance(limit, int) and 1 <= limit < len(all_cases):
                cases = all_cases[:limit]
            else:
                cases = all_cases
            with CLASSIFY_LOCK:
                rows: list[dict[str, Any]] = []
                latencies: list[float] = []
                correct_type = 0
                correct_tools = 0
                confusion: dict[str, dict[str, int]] = {}
                for index, (text, expected_type, expected_tools) in enumerate(cases):
                    began = time.perf_counter()
                    result = MODEL.predict(text, self.server.questions)
                    answers = self.server.compact(result)
                    latency = round((time.perf_counter() - began) * 1000, 1)
                    latencies.append(latency)
                    predicted_type = answers["task_type"]["choice"]
                    predicted_tools = float(answers["needs_tools"]["value"]) >= 0.5
                    correct_type += predicted_type == expected_type
                    correct_tools += predicted_tools == expected_tools
                    confusion.setdefault(expected_type, {}).setdefault(predicted_type, 0)
                    confusion[expected_type][predicted_type] += 1
                    rows.append({
                        "case_index": index,
                        "expected_type": expected_type,
                        "predicted_type": predicted_type,
                        "expected_tools": expected_tools,
                        "predicted_tools": predicted_tools,
                        "type_ok": predicted_type == expected_type,
                        "tools_ok": predicted_tools == expected_tools,
                        "latency_ms": latency,
                    })
            report = {
                "production_routing_approved": False,
                "sample_count": len(cases),
                "task_type_accuracy": round(correct_type / len(cases), 4),
                "needs_tools_accuracy": round(correct_tools / len(cases), 4),
                "warm_latency_median_ms": sorted(latencies)[len(latencies) // 2] if latencies else None,
                "task_type_confusion": confusion,
                "cases": rows,
            }
            self.send_json(HTTPStatus.OK, report)
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})


class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], runtime: Path, model_path: str,
                 html: str, questions: Any, compact: Any, cases: Any):
        if address[0] != "127.0.0.1":
            raise ValueError("observation console supports 127.0.0.1 only")
        self.runtime = runtime
        self.html = html
        self.questions = questions
        self.compact = compact
        self.cases = cases
        self.model_path = model_path
        super().__init__(address, Handler)

    def load_model(self) -> None:
        global MODEL
        import laya_mlx as laya

        started = time.perf_counter()
        try:
            MODEL = laya.load(self.model_path)
            STATE["load_ms"] = round((time.perf_counter() - started) * 1000, 1)
            STATE["ready"] = True
        except Exception as exc:
            STATE["error"] = str(exc)[:300]
            STATE["ready"] = False
        print(json.dumps({"model_ready": STATE["ready"], "load_ms": STATE["load_ms"],
                          "error": STATE["error"]}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=str(DEFAULT_RUNTIME / "models" / "laya-multilingual-mlx"))
    parser.add_argument("--runtime", default=str(DEFAULT_RUNTIME))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=19095)
    args = parser.parse_args()

    from server import QUESTIONS, compact_answers
    from evaluate import CASES

    html_path = Path(__file__).resolve().parent / "dashboard.html"
    server = DashboardServer(
        (args.host, args.port), Path(args.runtime), args.model,
        html_path.read_text(), QUESTIONS, compact_answers, CASES,
    )
    threading.Thread(target=server.load_model, daemon=True).start()
    print(json.dumps({"listening": f"{args.host}:{args.port}",
                      "runtime": args.runtime, "model": args.model}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
