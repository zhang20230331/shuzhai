# 云端打包与安装指南（APK + IPA）

本工程已配置 GitHub Actions 云构建：**不需要 Mac、不需要本地装任何构建工具**。
- iOS：macOS 云机器编译出**未签名 IPA** → 你的巨魔商店（TrollStore）直接安装，永久有效
- Android：Ubuntu 云机器编译出 **固定签名 debug APK** → 下载直接装

CI 同时会在安卓模拟器（x86_64 变体）与 iOS 模拟器里实际启动应用截图回归，产物见 Actions Artifacts：
- `shuzhai-android-apk` / `shuzhai-ios-ipa`：安装包
- `shuzhai-android-emulator-screens` / `shuzhai-ios-simulator-screens`：模拟器实测截图

App 是离线优先的：书籍存在手机里，**不依赖电脑开机**。
- 安卓内置 10 个精选离线音色（Kokoro 模型随 APK 打包，音色子集化 103→10，体积省约 47MB）
- 在家（电脑开着、同一 WiFi）：自动使用微软 Edge 神经语音（晓晓/云希…）
- 外出/电脑关机：自动切换内置音色（安卓）或系统语音，离线可听

## ★ 覆盖安装说明（重要）

自 v3.0 起安卓包使用**仓库内置固定签名**（`android/app/shuzhai.keystore`，PKCS12）：
- **v3.0 之后的每个新包都可以直接覆盖安装旧版**，不再需要卸载
- 版本号随 CI 运行次数自动递增，不会出现降级拒绝
- ⚠️ **从旧版（v2.x，历史 CI 临时签名）升级到 v3.0 需要先卸载一次** —— 旧包签名不同是历史遗留，仅此一次

## 本地构建（可选）

```bash
# 1) 部署语音资源（下载 AAR+模型，子集化音色；需 python3 + pip install onnx）
python scripts/setup_tts.py
# 2) 同步 web 资源
npx cap sync android
# 3) 编译（需 JDK 17+ 和 Android SDK；local.properties 写 sdk.dir=E:/你的SDK路径）
cd android && ./gradlew assembleDebug
# 模拟器用变体（追加 x86_64 ABI）：
./gradlew assembleDebug -PabiExtra=x86_64
```

---

## 一、推送仓库（约 5 分钟，只需做一次）

1. 打开 github.com → 右上角 + → New repository
   - 名称随意（如 `shuzhai`），选 **Private**，其它都不勾，点创建
2. 在本机 `novel-app` 目录打开命令行，执行（把 `你的用户名/shuzhai` 换掉）：

```bash
git remote add origin https://github.com/你的用户名/shuzhai.git
git push -u origin main
```

推送时弹窗登录 GitHub 即可。推上去后 Actions 会自动开始构建（首次手动触发也行：仓库页 → Actions → 选 "Build Android APK" 或 "Build iOS IPA" → Run workflow）。

## 二、下载产物

- 仓库页 → **Actions** → 点最近一次运行 → 页面底部 **Artifacts**：
  - `shuzhai-ios-ipa` → 解压得到 `shuzhai-unsigned.ipa`
  - `shuzhai-android-apk` → 解压得到 `app-debug.apk`
- 构建 10~15 分钟；以后每次改代码 push，会自动重新出包

## 三、iPhone 安装（巨魔）

1. 电脑上把 `shuzhai-unsigned.ipa` 通过微信/QQ「文件传输助手」发到手机，或存到 iCloud/文件 App
2. 手机打开**巨魔商店（TrollStore）→ Plus 号（+）→ 从文件导入** 该 IPA → 安装
3. 桌面出现「书斋」图标，永久有效，无需重签
   - 前提：你的系统在巨魔支持范围（iOS 14.0 – 16.6.1，你能装巨魔说明已满足）

## 四、安卓安装

1. 把 `app-debug.apk` 传到手机，点击安装 → 允许「未知来源」即可（debug 签名，可直接装）

## 五、App 内使用说明

- **导入**：书架 → ＋导入 TXT（手机「文件」里选书）/ 链接导入
- **音源自动切换**：启动和点听书时会探测家里电脑（默认 `http://192.168.0.205:9324`）
  - 通 → 音色面板显示 10 个 Edge 神经音色
  - 不通 → 显示「系统语音（当前离线）」，走手机自带语音
- **电脑 IP 变了**：手机打开书斋，进阅读页点中间呼出菜单 → 设置没有任何地址项时，在地址栏模式下执行
  `localStorage.setItem('sz_server','http://新IP:9324')`；最简单的方法是让路由器给电脑绑定固定 IP
- 目录结构：书在手机 IndexedDB（`shuzhai` 库），清 App 数据会丢书，换机需重新导入

## 六、常见问题

- **首次构建失败**：流水线是按 Capacitor 标准流程写的，若 Actions 报错，把错误日志发给 AI 修即可（一般是 Xcode/Gradle 版本小调整）
- **IPA 提示无法安装**：确认是巨魔安装而非系统安装器；未签名 IPA 只能进巨魔
- **想在手机浏览器直接用（不装 App）**：手机访问 `http://电脑IP:9324` 即旧方案，不受影响
