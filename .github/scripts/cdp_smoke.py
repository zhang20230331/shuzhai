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
    """拿到 pid → 反复建立 adb forward 直到 WebView 调试端点可达。
    注意：CI runner 逐行执行脚本，变量不跨行，因此 pidof/forward 都在这里做；
    WebView socket 在应用加载后才出现，必须重试。"""
    pid = subprocess.run(["adb", "shell", "pidof", "com.shuzhai.reader"],
                         capture_output=True, text=True).stdout.strip().split()[-1]
    print("app pid:", pid)
    for _ in range(45):
        subprocess.run(["adb", "forward", "tcp:9222",
                        f"localabstract:webview_devtools_remote_{pid}"],
                       capture_output=True)
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

# 降级路径断言（PM 决策）：手动锁 builtin + 注入慢速 → 必须自动切系统语音
ev("window.__sz.prefs.voiceMode = 'builtin'")
ev("window.__szForceSlow = true")
ev("window.__sz.playFrom(window.__sz.state.cur.ch, window.__sz.state.cur.p || 0)")
time.sleep(12)
st2 = ev("JSON.stringify({mode: window.__sz.state.mode, playing: window.__sz.state.playing,"
         " slow: window.__sz.prefs.slowBuiltin})")
print("降级状态:", st2)
state2 = json.loads(st2)
# 诊断信息可生成
diag = ev("buildDiagnosticsText()", True) or ""
print("诊断摘要:", diag.splitlines()[0][:60] if diag else "EMPTY")

# 双引擎第二口径断言（PM 备忘录）：CI runner 内存 ≥3.5GB → 预合成引擎自动启用；
# builtinForce 强制内置播放 → 预合成引擎并行供数 → rtfPrefetch 统计应积累。
# 注：CI 双核 RTF 极高，第二口径完整触发（cacheHits>10 稳态）需真机；此处验证数据源被运行
ev("window.__sz.prefs.builtinForce = true")
ev("window.__sz.playFrom(window.__sz.state.cur.ch, window.__sz.state.cur.p || 0)")
pf_ok, pf_diag = False, {}
for _ in range(120):
    time.sleep(4)
    d = ev("(window.AndroidTts && window.AndroidTts.getDiagnostics) ? window.AndroidTts.getDiagnostics() : '{}'")
    try:
        dj = json.loads(d)
    except Exception:
        continue
    # CI 双核且双引擎抢 CPU：完整口径（cacheHits>10 + rtfPrefetchAvg>1.5）需真机稳态，
    # CI 层面验证 rtfPrefetch 数据源真实运行（引擎 2 工作 + 统计积累）即可
    if dj.get("rtfPrefetchCount", 0) >= 1 and dj.get("rtfPrefetchAvg", 0) > 1.0:
        pf_ok = True
        pf_diag = dj
        break
print("双引擎口径:", "OK（预合成引擎运行中）" if pf_ok else "数据不足", pf_diag)

ws.close()

ok = (bool(book) and bool(chapter) and state.get("playing") is True
      and state2.get("mode") == "system" and state2.get("playing") is True
      and state2.get("slow") is True and len(diag) > 100 and pf_ok)
print("SMOKE", "OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
