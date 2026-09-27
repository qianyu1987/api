#!/usr/bin/env python3
"""One supervised LoRA fine-tune cycle for the Laya shadow classifier.

Research tool only: produces a drop-in merged checkpoint plus a JSON report
without prompt text. No evaluation output ever enables production routing.

Trainable set: LoRA adapters on encoder attention/MLP projections plus the
decision head, scorer and act head. Embeddings, layer norms, type embeddings
and all other encoder parameters stay frozen (raw arrays outside the
optimizer).

Usage (runtime venv only):
  .venv/bin/python tools/laya-shadow/train.py \
    --model $RUNTIME/models/laya-multilingual-mlx \
    --out   $RUNTIME/models/laya-multilingual-mlx-lora-v1 \
    --report $RUNTIME/train-report-YYYYMMDD.json
"""

from __future__ import annotations

import argparse
import json
import math
import random
import shutil
import time
from pathlib import Path
from statistics import median

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optimizers
from mlx.utils import tree_flatten
import laya_mlx
from laya_mlx import Agent
from laya_mlx.agent import collate_items
from laya_mlx.common import build_sequence, QTYPES, render_options, temp_bucket
from laya_mlx.model import DecisionModel, EncoderConfig, sanitize_weights, attention_masks
from server import QUESTIONS, TASK_LABELS

VALUE_ORDER = list(TASK_LABELS.values())  # [text, coding, image, video, other]


class LoRALinear(nn.Module):
    """Frozen base linear (raw arrays outside the optimizer) + rank-r adapter."""

    FROZEN: dict = {}

    def __init__(self, standard_name: str, base: "nn.Linear", rank: int):
        super().__init__()
        self.standard_name = standard_name
        out_dim, in_dim = base.weight.shape
        self.lora_a = mx.random.normal((in_dim, rank)) * (1.0 / math.sqrt(in_dim))
        self.lora_b = mx.zeros((out_dim, rank))
        self.FROZEN[standard_name + ".weight"] = base.weight
        base_bias = getattr(base, "bias", None)
        if base_bias is not None:
            self.FROZEN[standard_name + ".bias"] = base_bias

    def __call__(self, x):
        weight = self.FROZEN[self.standard_name + ".weight"]
        y = x @ weight.T
        if self.standard_name + ".bias" in self.FROZEN:
            y = y + self.FROZEN[self.standard_name + ".bias"]
        return y + (x @ self.lora_a) @ self.lora_b.T


def layer_norm_1d(x, weight, eps: float):
    mean = x.mean(axis=-1, keepdims=True)
    var = x.var(axis=-1, keepdims=True)
    return (x - mean) / mx.sqrt(var + eps) * weight


class TrainingModel(nn.Module):
    """Drop-in forward clone of DecisionModel with LoRA on the encoder linears."""

    def __init__(self, base: DecisionModel, enc_cfg: EncoderConfig, rank: int):
        super().__init__()
        self.enc_cfg = enc_cfg
        LoRALinear.FROZEN = {}
        emb = base.encoder.embeddings
        LoRALinear.FROZEN["embeddings.tok_embeddings.weight"] = emb.tok_embeddings.weight
        LoRALinear.FROZEN["embeddings.norm.weight"] = emb.norm.weight
        LoRALinear.FROZEN["final_norm.weight"] = base.encoder.final_norm.weight
        LoRALinear.FROZEN["type_emb.weight"] = base.type_emb.weight
        adapters = []
        for i, layer in enumerate(base.encoder.layers):
            for suffix, module in (("attn.Wqkv", layer.attn.Wqkv), ("attn.Wo", layer.attn.Wo),
                                   ("mlp.Wi", layer.mlp.Wi), ("mlp.Wo", layer.mlp.Wo)):
                key = f"encoder.layers.{i}.{suffix}"
                adapters.append(LoRALinear(key, module, rank))
            if i > 0:
                LoRALinear.FROZEN[f"layers.{i}.attn_norm.weight"] = layer.attn_norm.weight
            LoRALinear.FROZEN[f"layers.{i}.mlp_norm.weight"] = layer.mlp_norm.weight
        for i, adapter in enumerate(adapters):
            setattr(self, f"ad_{i}", adapter)
        self.adapters_count = len(adapters)
        self.head = base.head
        self.scorer = base.scorer
        self.act_head = base.act_head

    def _encoder(self, input_ids, attention_mask):
        cfg = self.enc_cfg
        x = mx.take(LoRALinear.FROZEN["embeddings.tok_embeddings.weight"], input_ids, axis=0)
        x = layer_norm_1d(x, LoRALinear.FROZEN["embeddings.norm.weight"], cfg.norm_eps)
        masks = attention_masks(attention_mask, cfg.local_attention)
        for i, layer_type in enumerate(cfg.layer_types):
            if i == 0:
                normed = x
            else:
                normed = layer_norm_1d(x, LoRALinear.FROZEN[f"layers.{i}.attn_norm.weight"], cfg.norm_eps)
            rope_base = cfg.rope_base(layer_type)
            qkv = getattr(self, 'ad_' + str(4 * i + 0))(normed).reshape(
                x.shape[0], x.shape[1], 3, cfg.num_attention_heads, cfg.head_dim)
            q, k, v = [qkv[:, :, j].transpose(0, 2, 1, 3) for j in range(3)]
            q = mx.fast.rope(q, cfg.head_dim, traditional=False, base=rope_base, scale=1.0, offset=0)
            k = mx.fast.rope(k, cfg.head_dim, traditional=False, base=rope_base, scale=1.0, offset=0)
            out = mx.fast.scaled_dot_product_attention(q, k, v, scale=cfg.head_dim ** -0.5, mask=masks[layer_type])
            x = x + getattr(self, 'ad_' + str(4 * i + 1))(out.transpose(0, 2, 1, 3).reshape(x.shape[0], x.shape[1], -1))
            normed2 = layer_norm_1d(x, LoRALinear.FROZEN[f"layers.{i}.mlp_norm.weight"], cfg.norm_eps)
            value, gate = mx.split(getattr(self, 'ad_' + str(4 * i + 2))(normed2), 2, axis=-1)
            x = x + getattr(self, 'ad_' + str(4 * i + 3))(nn.gelu(value) * gate)
        return layer_norm_1d(x, LoRALinear.FROZEN["final_norm.weight"], cfg.norm_eps)

    def forward(self, input_ids, attention_mask, marker_pos, marker_mask, qtype):
        h = self._encoder(input_ids, attention_mask)
        h = h + LoRALinear.FROZEN["type_emb.weight"][qtype][:, None, :]
        h = self.head(h, attention_mask[:, None, None, :].astype(mx.bool_))
        markers = h[mx.arange(h.shape[0])[:, None], mx.maximum(marker_pos, 0)]
        logits = self.scorer(markers).squeeze(-1).astype(mx.float32)
        logits = mx.where(marker_mask, logits, -1e4)
        p = mx.softmax(logits, axis=-1)
        k = mx.maximum(marker_mask.sum(axis=-1), 2).astype(mx.float32)
        entropy = -(p * mx.log(mx.maximum(p, 1e-9))).sum(axis=-1) / mx.log(k)
        top = mx.sort(p, axis=-1)[:, -2:]
        features = mx.stack([top[:, 1], top[:, 1] - top[:, 0], entropy, k / 255.0], axis=-1)
        pooled = mx.concatenate([h[:, 0].astype(mx.float32), features], axis=-1)
        action = self.act_head(pooled.astype(self.act_head.layers[0].weight.dtype))
        return logits, action.astype(mx.float32)

    def __call__(self, *args, **kwargs):
        return self.forward(*args, **kwargs)


def load_cases(builtin, external, extra_verified):
    cases = []
    for text, expected_type, expected_tools in builtin:
        cases.append({"text": text, "expected_type": expected_type, "expected_tools": bool(expected_tools),
                      "source": "builtin_smoke"})
    for case in external:
        cases.append({"text": case["text"], "expected_type": case["expected_type"],
                      "expected_tools": bool(case["expected_tools"]), "source": "external_unverified"})
    for case in extra_verified:
        cases.append({"text": case["text"], "expected_type": case["expected_type"],
                      "expected_tools": bool(case["expected_tools"]), "source": "verified"})
    return cases


def save_merged_checkpoint(base_model, out_dir: Path, base_dir: Path, model: TrainingModel):
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in ("rl_agent_config.json", "mlx_config.json", "encoder", "tokenizer"):
        source = base_dir / name
        if source.is_dir():
            shutil.copytree(source, out_dir / name, dirs_exist_ok=True)
        elif source.is_file():
            shutil.copy2(source, out_dir / name)
    flat = tree_flatten(base_model.parameters())
    lora_by_name = {}
    for adapter in [getattr(model, f'ad_{i}') for i in range(model.adapters_count)]:
        lora_by_name[adapter.standard_name + ".weight"] = adapter
    merged = []
    for name, value in flat:
        adapter = lora_by_name.get(name)
        if adapter is not None:
            value = value + adapter.lora_b @ adapter.lora_a.T
        merged.append((name, value))
    mx.eval([value for _, value in merged])
    mx.save_safetensors(str(out_dir / "model.safetensors"), dict(merged))


def evaluate_set(agent, case_list, questions):
    correct_type, correct_tools = 0, 0
    confusion = {}
    for case in case_list:
        result = agent.predict(case["text"], questions)
        raw_choice = result["answers"]["task_type"]["choice"]
        predicted_type = TASK_LABELS.get(raw_choice, raw_choice)
        predicted_tools = bool(result["answers"]["needs_tools"]["noul"] >= 0.5)
        if predicted_type == case["expected_type"]:
            correct_type += 1
        if predicted_tools == case["expected_tools"]:
            correct_tools += 1
        row = confusion.setdefault(case["expected_type"], {})
        row[raw_choice] = row.get(raw_choice, 0) + 1
    return {
        "cases": len(case_list),
        "task_type_accuracy": round(correct_type / len(case_list), 4) if case_list else None,
        "needs_tools_accuracy": round(correct_tools / len(case_list), 4) if case_list else None,
        "task_type_confusion": confusion,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Base Laya checkpoint directory")
    parser.add_argument("--out", required=True, help="Output merged checkpoint directory")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--external-cases", type=Path,
                        default=Path("/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow/independent-cases-20260924.json"))
    parser.add_argument("--extra-cases", type=Path, help="JSONL of verified {text, expected_type, expected_tools, verified: true}")
    parser.add_argument("--holdout-external", action="store_true",
                        help="Train without the external unverified set (evaluation only)")
    parser.add_argument("--rank", type=int, default=4)
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--lr", type=float, default=5e-4)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--val-fraction", type=float, default=0.2)
    parser.add_argument("--patience", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260926)
    args = parser.parse_args()

    random.seed(args.seed)
    mx.random.seed(args.seed)

    from evaluate import CASES as BUILTIN_CASES
    builtin = BUILTIN_CASES
    external = json.loads(args.external_cases.read_text()) if args.external_cases.is_file() else []
    extra_verified = []
    if args.extra_cases and args.extra_cases.is_file():
        for line in args.extra_cases.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            if entry.get("verified") is True and entry.get("text"):
                extra_verified.append(entry)
    train_cases = load_cases(builtin, [] if args.holdout_external else external, extra_verified)
    cases = train_cases

    agent = Agent(args.model, dtype="float32")
    tok = agent.tok
    max_len = agent.cfg.get("max_len", 512)
    head_max_len = agent.cfg.get("head_max_len", 192)
    internal_questions = {qid: agent._to_internal(qdef) for qid, qdef in QUESTIONS.items()}

    items = []
    for case in cases:
        for qid, internal in internal_questions.items():
            ids, markers = build_sequence(tok, case["text"], internal, max_len, head_max_len)
            if len(markers) != len(render_options(internal)):
                raise ValueError(f"marker count mismatch for {case['source']} case")
            target = VALUE_ORDER.index(case["expected_type"]) if qid == "task_type" else (1 if case["expected_tools"] else 0)
            items.append({"case": case, "qid": qid, "ids": ids, "markers": markers,
                          "qtype": QTYPES[internal["t"]], "target": target, "k": len(markers)})

    n = len(items)
    order = list(range(n))
    random.shuffle(order)
    val_count = int(n * args.val_fraction)
    val_items = [items[i] for i in order[:val_count]]
    train_pool = [items[i] for i in order[val_count:]]

    def temperature_of(qtype: int, k: int) -> float:
        return agent.temperature_by_options.get(temp_bucket(qtype, k), agent.temperature[qtype])

    def chunk_stats(chunk, model):
        batch = collate_items(
            [{"ids": it["ids"], "markers": it["markers"], "qtype": it["qtype"]} for it in chunk],
            tok.pad_token_id)
        tensors = {key: mx.array(value) for key, value in batch.items()}
        logits, _action = model(**tensors)
        temps = mx.array([temperature_of(it["qtype"], it["k"]) for it in chunk], dtype=mx.float32)
        scaled = logits / temps[:, None]
        targets = mx.array([it["target"] for it in chunk])
        loss = nn.losses.cross_entropy(scaled, targets, reduction="mean")
        correct = int((mx.argmax(scaled, axis=-1) == targets).sum())
        return loss, correct, len(chunk)

    enc_cfg = EncoderConfig.from_dict(agent.encoder_cfg)
    base_model = DecisionModel(enc_cfg, agent.cfg)
    base_model.load_weights(list(sanitize_weights(mx.load(str(Path(args.model) / "model.safetensors"))).items()), strict=True)
    model = TrainingModel(base_model, enc_cfg, args.rank)
    # Parity: untrained TrainingModel forward must match the stock base model.
    parity_items = train_pool[: min(args.batch_size, len(train_pool))]
    parity_batch = collate_items(
        [{"ids": it["ids"], "markers": it["markers"], "qtype": it["qtype"]} for it in parity_items],
        tok.pad_token_id)
    parity_tensors = {key: mx.array(value) for key, value in parity_batch.items()}
    base_logits, _base_act = base_model(**parity_tensors)
    mine_logits, _mine_act = model(**parity_tensors)
    parity_diff = float(mx.abs(base_logits - mine_logits).max())
    mx.eval(base_logits, mine_logits)
    print("parity max |logit diff| =", parity_diff)

    optimizer = optimizers.Adam(learning_rate=args.lr)

    best = (float("inf"), 0, 0)
    history = []
    for epoch in range(1, args.epochs + 1):
        random.shuffle(train_pool)
        total_loss, total_correct, total_count = 0.0, 0, 0
        for start in range(0, len(train_pool), args.batch_size):
            chunk = train_pool[start:start + args.batch_size]

            def loss_fn(m, chunk=chunk):
                return chunk_stats(chunk, m)[0]

            grads = mx.grad(loss_fn)(model)
            clipped, _grad_norm = optimizers.clip_grad_norm(grads, 1.0)
            optimizer.update(model, clipped)
            loss, correct, count = chunk_stats(chunk, model)
            total_loss += loss.item() * count
            total_correct += correct
            total_count += count
        val_loss = chunk_stats(val_items, model)[0].item()
        train_metric = (total_loss / total_count, total_correct / total_count)
        history.append({"epoch": epoch, "train_loss": round(train_metric[0], 4),
                        "train_acc": round(train_metric[1], 4), "val_loss": round(val_loss, 4)})
        if val_loss < best[0] - 1e-4:
            best = (val_loss, train_metric[1], epoch)
        if epoch - best[2] >= args.patience and epoch > best[2]:
            history.append({"note": "early_stop", "epoch": epoch})
            break

    save_merged_checkpoint(base_model, Path(args.out), Path(args.model), model)
    trained_agent = laya_mlx.load(str(args.out), dtype="float32")

    builtin_structured = [{"text": t, "expected_type": et, "expected_tools": bool(e_to)} for (t, et, e_to) in builtin]
    sections = {}
    for name, model_agent, case_list in (
        ("base_builtin", agent, builtin_structured),
        ("trained_builtin", trained_agent, builtin_structured),
        ("base_external", agent, external),
        ("trained_external", trained_agent, external),
    ):
        if not case_list:
            sections[name] = {"cases": 0}
            continue
        sections[name] = evaluate_set(model_agent, case_list, QUESTIONS)

    report = {
        "tool": "laya-shadow/train.py",
        "observation_only": True,
        "production_routing_approved": False,
        "data_notes": {
            "builtin": "agent-authored synthetic smoke cases including previously tuned examples; not a holdout",
            "external": "independent-cases-20260924.json, provenance unverified, agent self-labeled",
            "verified_queue": len(extra_verified),
            "holdout_external": bool(getattr(args, "holdout_external", False)),
        },
        "config": {"seed": args.seed, "rank": args.rank, "lr": args.lr, "grad_clip": 1.0, "epochs_run": len(history),
                   "batch_size": args.batch_size, "val_fraction": args.val_fraction,
                   "train_cases": len(train_pool) // 2, "val_cases": len(val_items) // 2},
        "best_val_loss": round(best[0], 4),
        "best_epoch": best[2],
        "history_tail": history[-8:],
        "results": sections,
        "out_dir": str(args.out),
    }
    if args.report:
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key not in ("history_tail",)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
