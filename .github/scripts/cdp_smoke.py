#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CI 模拟器冒烟：通过 CDP 驱动书斋 APK 内 WebView 走完核心链路。

不依赖屏幕分辨率/坐标：直接向 WebView 发 Runtime.evaluate，
用页面自带测试钩子 window.__sz 操作，截图留档，关键断言失败则退出非零。

前置：模拟器已启动、APK 已安装、应用已启动、adb forward tcp:9222 已建立。
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

import websocket

SHOTS = sys.argv[1] if len(sys.argv) > 1 else "shots"
os.makedirs(SHOTS, exist_ok=True)


def shot(name: str) -> None:
    with open(os.path.join(SHOTS, name), "wb") as f:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=f, check=True)


def page_ws() -> str:
    for _ in range(30):
        try:
            with urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=5) as r:
                pages = json.load(r)
            if pages:
                return pages[0]["webSocketDebuggerUrl"]
        except Exception:
            time.sleep(2)
    raise SystemExit("CDP 页面不可达")


ws = websocket.create_connection(page_ws(), timeout=90, suppress_origin=True)
_id = [0]


def ev(expr: str, await_promise: bool = False):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True,
                                   "awaitPromise": await_promise}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == _id[0]:
            return m["result"]["result"].get("value")


ver = ev("document.querySelector('.ver') && document.querySelector('.ver').textContent")
print("版本:", ver)

# 书城导入第一本书 → 自动进阅读器
book = ev("""(async () => {
  document.getElementById('btnStore').click();
  await new Promise(r => setTimeout(r, 800));
  const it = document.querySelectorAll('#storeList .voice-item')[0];
  if (!it) return null;
  it.click();
  return it.textContent;
})()""", True)
print("导入:", book)
time.sleep(10)
shot("02-reader.png")
chapter = ev("document.getElementById('chapterTitle').textContent")
print("章节:", chapter)

# 呼出菜单 → 点听书（真实 UI 按钮）
ev("window.__sz.toggleMenu(true)")
time.sleep(1)
shot("03-menu.png")
ev("document.getElementById('btnListen').click()")

# 等_builtin 引擎就绪并朗读 40 秒（首次加载模型 + 合成）
time.sleep(40)
shot("04-listening.png")
st = ev("JSON.stringify({playing: window.__sz.state.playing, mode: window.__sz.state.mode,"
        " cur: window.__sz.state.cur, hl: document.querySelectorAll('#track .seg.on').length})")
print("听书状态:", st)
state = json.loads(st)

ws.close()

ok = bool(book) and bool(chapter) and state.get("playing") is True
print("SMOKE", "OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
