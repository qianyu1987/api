#!/usr/bin/env python3
"""Local-only HTTP wrapper for Laya shadow routing experiments."""

from __future__ import annotations

import argparse
import hmac
import json
import os
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import BoundedSemaphore
from typing import Any

import laya_mlx as laya


TASK_LABELS = {
    "回答问题、解释知识、翻译或撰写普通文本": "text",
    "编写、审查、调试或修改程序代码": "coding",
    "生成或编辑图片": "image",
    "生成或编辑视频": "video",
    "以上都不属于": "other",
}

QUESTIONS = {
    "task_type": {
        "type": "choice",
        "instructions": "用户主要要求系统完成哪一种任务？只判断主要交付结果。",
        "criteria": list(TASK_LABELS),
    },
    "needs_tools": {
        "type": "noul",
        "instructions": "正确完成请求是否必须读取实时信息、用户私有数据、上传文件，或操作外部软件？",
    },
}


def compact_answers(result: dict[str, Any]) -> dict[str, Any]:
    answers: dict[str, Any] = {}
    for name, value in result.get("answers", {}).items():
        if value.get("type") == "choice":
            choice = value.get("choice")
            answers[name] = {
                "choice": TASK_LABELS.get(choice, choice) if name == "task_type" else choice,
                "confidence": value.get("confidence"),
                "probabilities": value.get("probabilities", {}),
            }
        else:
            answers[name] = {
                "value": value.get("noul"),
                "confidence": value.get("confidence"),
            }
    return answers


class LayaServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], model_path: str, token: str, concurrency: int):
        if address[0] != "127.0.0.1":
            raise ValueError("local prototype only supports 127.0.0.1")
        if not token:
            raise ValueError("LAYA_SHADOW_TOKEN is required")
        if concurrency != 1:
            raise ValueError("shared MLX model requires concurrency=1")
        started = time.perf_counter()
        self.agent = laya.load(model_path)
        self.load_ms = round((time.perf_counter() - started) * 1000, 1)
        self.token = token
        self.slots = BoundedSemaphore(concurrency)
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: LayaServer

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, format: str, *args: Any) -> None:
        # Never place user prompt content in access logs.
        pass  # Request paths can contain secrets; do not log arbitrary client input.

    def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        if not self.server.token:
            return True
        supplied = self.headers.get("authorization", "").removeprefix("Bearer ")
        return hmac.compare_digest(supplied, self.server.token)

    def do_GET(self) -> None:
        if self.path != "/healthz":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        self.send_json(HTTPStatus.OK, {"ok": True, "mode": "shadow", "load_ms": self.server.load_ms})

    def do_POST(self) -> None:
        if self.path != "/v1/classify":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self.authorized():
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 32_768:
                raise ValueError("body_size")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("invalid_object")
            text = payload.get("text")
            if not isinstance(text, str) or not text.strip() or len(text) > 8_000:
                raise ValueError("invalid_text")
        except (ValueError, json.JSONDecodeError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
            return

        if not self.server.slots.acquire(blocking=False):
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "busy"})
            return
        try:
            started = time.perf_counter()
            result = self.server.agent.predict(text, QUESTIONS)
            duration_ms = round((time.perf_counter() - started) * 1000, 1)
            self.send_json(HTTPStatus.OK, {
                "mode": "shadow",
                "duration_ms": duration_ms,
                "answers": compact_answers(result),
            })
        except Exception:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "inference_failed"})
        finally:
            self.server.slots.release()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=19091)
    parser.add_argument("--concurrency", type=int, default=1)
    args = parser.parse_args()
    token = os.environ.get("LAYA_SHADOW_TOKEN", "")
    server = LayaServer((args.host, args.port), args.model, token, args.concurrency)
    print(json.dumps({"ready": True, "host": args.host, "port": args.port, "load_ms": server.load_ms}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
