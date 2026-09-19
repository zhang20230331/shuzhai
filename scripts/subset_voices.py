#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Kokoro voices.bin 音色子集化：103 个音色裁剪到精选 10 个。

voices.bin 是裸的 float32 连续张量流：每个音色一段 [510,256] float32
（510*256*4 = 522240 字节），sid 即段序号。裁剪 = 按新顺序拼出子集。

原 sid → 音色名（顺序由 sherpa-onnx scripts/kokoro/v1.1-zh/generate_voices_bin.py
与 hexgrad/Kokoro-82M-v1.1-zh 的 voices/ 文件清单共同确定）：
  0  af_maple   美音女声
  1  af_sol     美音女声
  2  bf_vale    英音女声
  3..57  zf_001..zf_099（55 个存在的）中文女声
  58..102 zm_009..zm_100（45 个存在的）中文男声

精选 10 个（zf_001 / zm_010 是官方 README 的演示音色）。

用法: python scripts/subset_voices.py <voices.bin 原文件> <输出文件>
"""

import sys
from pathlib import Path

VOICE_BYTES = 510 * 256 * 4

# (原 sid, 展示名) 按新 sid 顺序排列：0-3 中文女声，4-6 中文男声，7-9 英文
KEEP = [
    (3, "中文女声 · 晚晴"),   # zf_001，官方演示音色
    (4, "中文女声 · 知夏"),
    (13, "中文女声 · 念安"),
    (38, "中文女声 · 疏影"),
    (58, "中文男声 · 青山"),
    (59, "中文男声 · 沉舟"),  # zm_010，官方演示音色
    (89, "中文男声 · 远山"),
    (0, "美音女声 · 枫"),     # af_maple
    (1, "美音女声 · 阳"),     # af_sol
    (2, "英音女声 · 薇"),     # bf_vale
]


def subset(src: Path, dst: Path) -> None:
    data = src.read_bytes()
    if len(data) % VOICE_BYTES:
        raise SystemExit(f"voices.bin 大小异常: {len(data)} 不是 {VOICE_BYTES} 的整数倍")
    total = len(data) // VOICE_BYTES
    out = bytearray()
    for sid, _ in KEEP:
        if not 0 <= sid < total:
            raise SystemExit(f"sid {sid} 越界（共 {total} 个音色）")
        out += data[sid * VOICE_BYTES:(sid + 1) * VOICE_BYTES]
    if dst.resolve() == src.resolve():
        tmp = dst.with_suffix(".tmp")
        tmp.write_bytes(out)
        tmp.replace(dst)
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(out)
    print(f"[子集] {len(data)//1024//1024}MB -> {len(out)//1024//1024}MB（{total} -> {len(KEEP)} 个音色）")


# 新 sid -> 原始音色名（与 KEEP 顺序一致）
NEW_NAMES = ["zf_001", "zf_002", "zf_019", "zf_071", "zm_009", "zm_010", "zm_065",
             "af_maple", "af_sol", "bf_vale"]


def patch_model(model_path: Path) -> None:
    """把 ONNX 元数据里的音色数量/名字改成子集后的情况。

    sherpa-onnx 启动时校验 voices.bin 的 floats 数 = style_dim[0]*style_dim[2]*n_speakers，
    不改元数据 n_speakers=103 会直接判 voices.bin 损坏拒绝加载。
    """
    import onnx  # 延迟导入：仅模型子集化时需要

    m = onnx.load(str(model_path), load_external_data=False)
    d = {p.key: p.value for p in m.metadata_props}
    old = dict(kv.split("->") for kv in d["speaker2id"].split(","))
    id2sp = ",".join(f"{i}->{old[name]}" for i, name in enumerate(NEW_NAMES))
    sp2id = ",".join(f"{old[name]}->{i}" for i, name in enumerate(NEW_NAMES))
    for p in m.metadata_props:
        if p.key == "n_speakers":
            p.value = str(len(NEW_NAMES))
        elif p.key == "id2speaker":
            p.value = id2sp
        elif p.key == "speaker2id":
            p.value = sp2id
        elif p.key == "speaker_names":
            p.value = ",".join(NEW_NAMES)
    tmp = model_path.with_suffix(".tmp")
    onnx.save(m, str(tmp))
    tmp.replace(model_path)
    print(f"[模型] {model_path.name} 元数据已改为 {len(NEW_NAMES)} 音色")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    subset(Path(sys.argv[1]), Path(sys.argv[2]))
