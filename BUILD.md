# 云端打包与安装指南（APK + IPA）

本工程已配置 GitHub Actions 云构建：**不需要 Mac、不需要本地装任何构建工具**。
- iOS：macOS 云机器编译出**未签名 IPA** → 你的巨魔商店（TrollStore）直接安装，永久有效
- Android：Ubuntu 云机器编译出 **debug 签名 APK** → 下载直接装

App 是离线优先的：书籍存在手机里，**不依赖电脑开机**。
- 在家（电脑开着、同一 WiFi）：自动使用微软 Edge 神经语音（晓晓/云希…）
- 外出/电脑关机：自动切换系统语音（iOS 用 Siri 声音，安卓用系统 TTS），离线可听

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
