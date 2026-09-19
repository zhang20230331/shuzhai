#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""部署离线语音（TTS）资源到 android 工程。

下载并放置：
  1. sherpa-onnx 官方 AAR（含 JNI so + Kotlin API，Apache-2.0）
     -> android/app/libs/sherpa-onnx.aar
  2. Kokoro int8 中英双语模型（Apache-2.0，可免费商用），并做音色子集化：
     103 个音色精选为 10 个（voices.bin 51MB -> 4MB），模型元数据同步改写
     -> android/app/src/main/assets/tts/

用法（本地或 CI，均可重复执行，已就绪的文件会跳过）：
    python scripts/setup_tts.py

归档缓存在 scripts/.tts-cache/，删除该目录即可强制重新下载。
"""

import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import subset_voices  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "scripts" / ".tts-cache"
LIBS = ROOT / "android" / "app" / "libs"
ASSETS_TTS = ROOT / "android" / "app" / "src" / "main" / "assets" / "tts"

SHERPA_VERSION = "v1.13.7"
# 官方 AAR（含 Kotlin API + 全部 ABI 的 JNI so），直接放进 android/app/libs/
ANDROID_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    f"{SHERPA_VERSION}/sherpa-onnx-1.13.7.aar"
)
ANDROID_SIZE = 49113869

MODEL_NAME = "kokoro-int8-multi-lang-v1_1"
MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
    f"{MODEL_NAME}.tar.bz2"
)
MODEL_SIZE = 147031220

# 模型目录内需要打进 APK 的文件（espeak-ng-data 整目录）
MODEL_FILES = [
    "model.int8.onnx",
    "voices.bin",
    "tokens.txt",
    "lexicon-zh.txt",
    "lexicon-us-en.txt",
    "phone-zh.fst",
    "date-zh.fst",
    "number-zh.fst",
    "LICENSE",
]


def mb(n: float) -> str:
    return f"{n / 1024 / 1024:.1f}MB"


def download(url: str, dest: Path, expect_size: int) -> Path:
    if dest.exists() and dest.stat().st_size == expect_size:
        print(f"[缓存命中] {dest.name}")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"[下载] {url}")
    print(f"       -> {dest}")
    last_err = None
    for _ in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
                total = 0
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    total += len(chunk)
                    if total % (50 << 20) < (1 << 20):
                        print(f"       {mb(total)} ...", flush=True)
            if tmp.stat().st_size != expect_size:
                raise IOError(
                    f"大小不符: 期望 {expect_size}, 实际 {tmp.stat().st_size}"
                )
            tmp.replace(dest)
            print(f"[下载完成] {mb(dest.stat().st_size)}")
            return dest
        except Exception as e:  # noqa: BLE001 - 重试所有网络错误
            last_err = e
            print(f"[重试] {e}")
    raise SystemExit(f"下载失败: {url} ({last_err})")


def copy_file(src: Path, dst: Path) -> bool:
    """目标已存在且大小一致则跳过。返回是否发生了拷贝。"""
    if dst.exists() and dst.stat().st_size == src.stat().st_size:
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    return True


def deploy_aar(aar: Path) -> None:
    dest = LIBS / "sherpa-onnx.aar"
    if dest.exists() and dest.stat().st_size == aar.stat().st_size:
        print(f"[跳过] {dest.relative_to(ROOT)}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(aar, dest)
    print(f"[部署] {dest.relative_to(ROOT)} ({mb(dest.stat().st_size)})")


def deploy_model(model_tar: Path) -> None:
    prefix = f"{MODEL_NAME}/"
    total = copied = 0
    with tarfile.open(model_tar, "r:bz2") as tf:
        members = []
        for m in tf.getmembers():
            if m.isfile() and (
                m.name.startswith(prefix + "espeak-ng-data/")
                or any(m.name == prefix + f for f in MODEL_FILES)
            ):
                members.append(m)
        for m in members:
            total += 1
            rel = m.name[len(prefix):]
            dst = ASSETS_TTS / rel
            if dst.exists() and dst.stat().st_size == m.size:
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            f = tf.extractfile(m)
            assert f is not None
            with open(dst, "wb") as out:
                shutil.copyfileobj(f, out)
            copied += 1
    print(f"[部署] {ASSETS_TTS.relative_to(ROOT)}: {total} 个文件（新拷贝 {copied} 个）")

    for f in MODEL_FILES:
        p = ASSETS_TTS / f
        if not p.exists():
            raise SystemExit(f"缺少模型文件: {p}")
    (ASSETS_TTS / "espeak-ng-data" / "phondata").exists() or SystemExit(
        "缺少 espeak-ng-data"
    )


def ensure_onnx() -> None:
    try:
        import onnx  # noqa: F401
    except ImportError:
        print("[依赖] 安装 onnx（模型元数据改写需要）")
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "onnx"], check=True)


def subset_assets() -> None:
    """音色子集化：voices.bin 103 -> 10，模型元数据 n_speakers 同步改写。
    幂等：已是子集尺寸则跳过。"""
    voices = ASSETS_TTS / "voices.bin"
    model = ASSETS_TTS / "model.int8.onnx"
    expected_voices = len(subset_voices.KEEP) * subset_voices.VOICE_BYTES
    if voices.stat().st_size != expected_voices:
        subset_voices.subset(voices, voices)
    else:
        print("[跳过] voices.bin 已是子集")
    if model.stat().st_size != MODEL_SIZE_PATCHED:
        ensure_onnx()
        subset_voices.patch_model(model)
    else:
        print("[跳过] 模型元数据已改写")


# 原始 int8 模型 114299010 字节；元数据改写后 114296204 字节（id2speaker 等长串变短）。
# 不相等就重新 patch（幂等），用体积差判等避免重复加载 110MB 模型。
MODEL_SIZE_PATCHED = 114296204


def main() -> None:
    print(f"== 书斋离线语音资源部署 ==")
    print(f"工程根目录: {ROOT}")
    android_tar = download(
        ANDROID_URL, CACHE / "sherpa-onnx-1.13.7.aar", ANDROID_SIZE
    )
    model_tar = download(MODEL_URL, CACHE / f"{MODEL_NAME}.tar.bz2", MODEL_SIZE)
    deploy_aar(android_tar)
    deploy_model(model_tar)
    subset_assets()
    print("== 完成 ==")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
