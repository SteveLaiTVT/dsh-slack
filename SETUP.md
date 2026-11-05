# 装配清单（用户侧动作，约 10 分钟）

## 1. 建 Slack 应用（用户在浏览器里做）
1. 打开 api.slack.com/apps → Create New App → From a manifest → 选 Fluxion 工作区 → 粘贴 `slack-app-manifest.yaml` 全文 → Create。
2. 左侧 Socket Mode 页：确认已启用，生成一个 App-Level Token（权限选 `connections:write`），命名如 `dsh-socket` → 得到 `xapp-...`。
3. 左侧 Install App 页：Install to Fluxion → 得到 Bot User OAuth Token `xoxb-...`。
4. 两个 token 不要发聊天。装插件时在本机填入 dsh 配置（见插件 README 的配置说明，最终存入 dsh 凭据区）。

## 2. 频道（v0.2：一频道一仓库）
1. 按仓库建频道：一个仓库一个派单频道（如 `#ble-sim` 对 ble-sim 仓、`#cbec-software` 对 cbec-software 仓；已有频道直接用，不必新建）。频道 ID 从频道链接里取（`…/archives/<这一串就是 channelId>`）。
2. 把 dsh bot 应用拉进每个派单频道（频道里 /invite @dsh）。
3. 在插件配置里填 `channelRepos` 映射（channelId → repo / 本机 root / remote，见 README 配置示例）。该频道里派单不用再写仓库名；开工前插件会按映射自动 clone（本地缺失）/ pull（已存在）对应仓库。

## 3. 公司机前置确认（AC-11）
- dsh 版本 ≥ 0.2.1-rc.1（`dsh --version` 或 Web UI 关于页）；低于此先升级。
- 默认模型为 DeepSeek V4.1 Flash 的 1017 版（模型选择里确认 `deepseek-v4.1-flash` 指向 1017；API 侧 2026-10-17 已自动切换，同名即新版）。

## 4. 装插件（Codex 交付后进行）
- 按插件 README 把包加入本机 dsh 的 profile 组合并填配置（`channelRepos` 频道→仓库映射、token 凭据引用），重启 dsh，确认 bot 在每个派单频道显示在线；再在两个不同频道各派一单不写仓库名的测试单，核对 session 工作目录与仓库是否按频道正确对应（AC-12）。
