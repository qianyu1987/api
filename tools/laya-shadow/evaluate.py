#!/usr/bin/env python3
"""Reproducible diagnostic evaluation; never a production routing approval."""

from __future__ import annotations

import argparse
import json
import time
import hashlib
from pathlib import Path
from statistics import median

import laya_mlx as laya

from server import QUESTIONS, compact_answers


CASES = [
    # Agent-authored synthetic smoke cases, including previously tuned examples.
    ("把这句话翻译成英文：今天天气很好。", "text", False),
    ("写一封礼貌的会议改期邮件。", "text", False),
    ("解释什么是 HTTP 状态码 429。", "text", False),
    ("用三句话总结什么是光合作用。", "text", False),
    ("帮我想五个咖啡店的名字。", "text", False),
    ("把这段通知改得更简洁、语气友好。", "text", False),
    ("用中文解释复利是什么意思。", "text", False),
    ("给这篇文章拟一个更清楚的标题。", "text", False),
    ("修复 TypeScript 服务里的并发竞态并补测试。", "coding", True),
    ("审查这个 SQL 查询为什么会重复扣款。", "coding", True),
    ("给我写一个 Python CSV 去重脚本。", "coding", False),
    ("这个 JavaScript 报错可能是什么原因？", "coding", False),
    ("写一个正则表达式，匹配中国手机号。", "coding", False),
    ("帮我把这个接口迁移到 Fastify。", "coding", True),
    ("解释这段 Go 代码的时间复杂度。", "coding", False),
    ("为这个 React 组件增加键盘导航。", "coding", True),
    ("生成一张赛博朋克城市夜景图片。", "image", True),
    ("画一张适合儿童绘本的森林小屋插画。", "image", True),
    ("设计一张极简风格的咖啡新品海报。", "image", True),
    ("生成透明背景的金色圆形图标。", "image", True),
    ("把上传的产品图改成白色背景。", "image", True),
    ("为一家海边餐厅做菜单封面图。", "image", True),
    ("生成一张 16:9 的科技发布会背景图。", "image", True),
    ("创建一幅水彩风格的春日花园。", "image", True),
    ("制作一个 9:16 的咖啡广告短视频。", "video", True),
    ("把这段素材剪成 15 秒竖屏视频。", "video", True),
    ("生成海浪拍打礁石的电影感视频。", "video", True),
    ("做一个介绍新手机功能的产品短片。", "video", True),
    ("让这张静态风景图变成缓慢推镜头的视频。", "video", True),
    ("生成一段 6 秒的卡通小狗奔跑动画。", "video", True),
    ("把横屏访谈剪辑改成适合手机观看的短视频。", "video", True),
    ("制作一段带字幕的新品宣传片。", "video", True),
    ("查询今天深圳天气并推荐出行时间。", "text", True),
    ("读取我的账户余额并告诉我还能用多少额度。", "text", True),
    ("请帮我计算 125 乘以 48。", "text", False),
    ("比较一下租房和买房各自的优缺点。", "text", False),
    ("现在美元兑人民币汇率是多少？", "text", True),
    ("根据这段代码，找出可能造成内存泄漏的地方。", "coding", True),
    ("写一个 SQL 查询，统计每月新增用户数。", "coding", False),
    ("做一张复古风格的音乐节宣传图。", "image", True),
    ("生成一段无人机飞越雪山的 10 秒视频。", "video", True),
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--cases", type=Path, help="JSON array of text, expected_type, expected_tools objects")
    parser.add_argument("--report", type=Path, help="Save a report without prompt text")
    args = parser.parse_args()
    cases = CASES
    if args.cases:
        data = json.loads(args.cases.read_text())
        if not isinstance(data, list) or not data:
            parser.error("cases must be a non-empty JSON array")
        cases = []
        for row in data:
            if (not isinstance(row, dict) or not isinstance(row.get("text"), str)
                    or not row["text"].strip() or len(row["text"]) > 8000
                    or row.get("expected_type") not in {"text", "coding", "image", "video", "other"}
                    or not isinstance(row.get("expected_tools"), bool)):
                parser.error("invalid case: require text, expected_type and boolean expected_tools")
            cases.append((row["text"], row["expected_type"], row["expected_tools"]))
    started = time.perf_counter()
    agent = laya.load(args.model)
    load_ms = (time.perf_counter() - started) * 1000
    rows = []
    latencies = []
    correct_type = 0
    correct_tools = 0
    confusion: dict[str, dict[str, int]] = {}
    for index, (text, expected_type, expected_tools) in enumerate(cases):
        began = time.perf_counter()
        answers = compact_answers(agent.predict(text, QUESTIONS))
        latency = (time.perf_counter() - began) * 1000
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
        })
    report = {
        "dataset_kind": "external_unverified" if args.cases else "synthetic_smoke_not_holdout",
        "dataset_sha256": hashlib.sha256(json.dumps(cases, ensure_ascii=False).encode()).hexdigest(),
        "questions_sha256": hashlib.sha256(json.dumps(QUESTIONS, ensure_ascii=False).encode()).hexdigest(),
        "sample_count": len(cases),
        "production_routing_approved": False,
        "load_ms": round(load_ms, 1),
        "warm_latency_median_ms": round(median(latencies[1:]), 1) if len(latencies) > 1 else None,
        "task_type_accuracy": round(correct_type / len(cases), 4),
        "needs_tools_accuracy": round(correct_tools / len(cases), 4),
        "task_type_confusion": confusion,
        "cases": rows,
    }
    serialized = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.write_text(serialized + "\n")
    print(serialized)


if __name__ == "__main__":
    main()
