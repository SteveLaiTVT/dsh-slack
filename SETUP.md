# 装配清单（用户侧动作，约 5 分钟）

## 1. 建 Slack 应用（用户在浏览器里做）
1. 打开 api.slack.com/apps → Create New App → From a manifest → 选 Fluxion 工作区 → 粘贴 `slack-app-manifest.yaml` 全文 → Create。
2. 左侧 Socket Mode 页：确认已启用，生成一个 App-Level Token（权限选 `connections:write`），命名如 `dsh-socket` → 得到 `xapp-…`。
3. 左侧 Install App 页：Install to Fluxion → 得到 Bot User OAuth Token `xoxb-…`。
4. 两个 token 不要发聊天。装插件时只存入公司机 dsh 进程的环境变量（`DSH_SLACK_APP_TOKEN` / `DSH_SLACK_BOT_TOKEN`），不进任何配置/仓库。

## 2. 频道（v0.3：零配置，主题即配置）
1. 想让 dsh 在哪个频道干活，就把 bot 拉进哪个频道（频道里 /invite @dsh）；不需要在插件里做任何频道配置，任何成员都能在频道里派单。
2. 在频道主题/说明里写明仓库地址与开发流程规范（稿子见 `CHANNEL-TOPICS.md`）——频道首次接单时插件会把主题/说明/近期消息读作上下文交给 dsh，它据此定仓与守流程。主题随时可改，插件在主题变化后自动重读。

## 3. 公司机前置确认（AC-11）
- dsh 版本 ≥ 0.2.1-rc.1（`dsh --version` 或 Web UI 关于页）；低于此先升级。
- 默认模型为 DeepSeek V4.1 Flash 的 1017 版（模型选择里确认 `deepseek-v4.1-flash` 指向 1017；API 侧 2026-10-17 已自动切换，同名即新版）。

## 4. 装插件
- 按插件 README 把包加入本机 dsh 的 profile 组合（配置可整段留空，最多填一个 `workdir`），注入两个 token 环境变量，重启 dsh，确认 bot 在频道里在线；然后在任意频道发一条冒烟单核对：`[派单] 只做检查，不要改任何文件：报一下你从频道上下文读到的仓库与流程、当前工作目录`——回帖与交卷正常即装配完成（AC-01/AC-14/AC-15 真实环境版）。
