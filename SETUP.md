# 装配清单（用户侧动作，约 10 分钟）

## 1. 建 Slack 应用（用户在浏览器里做）
1. 打开 api.slack.com/apps → Create New App → From a manifest → 选 Fluxion 工作区 → 粘贴 `slack-app-manifest.yaml` 全文 → Create。
2. 左侧 Socket Mode 页：确认已启用，生成一个 App-Level Token（权限选 `connections:write`），命名如 `dsh-socket` → 得到 `xapp-...`。
3. 左侧 Install App 页：Install to Fluxion → 得到 Bot User OAuth Token `xoxb-...`。
4. 两个 token 不要发聊天。装插件时在本机填入 dsh 配置（见插件 README 的配置说明，最终存入 dsh 凭据区）。

## 2. 频道
1. 在 Fluxion 新建私有频道 `#dsh-dispatch`（名字可改，频道 ID 填进插件配置）。
2. 把新建的 dsh bot 应用拉进该频道（频道里 /invite @dsh）。

## 3. 公司机前置确认（AC-11）
- dsh 版本 ≥ 0.2.1-rc.1（`dsh --version` 或 Web UI 关于页）；低于此先升级。
- 默认模型为 DeepSeek V4.1 Flash 的 1017 版（模型选择里确认 `deepseek-v4.1-flash` 指向 1017；API 侧 2026-10-17 已自动切换，同名即新版）。

## 4. 装插件（Codex 交付后进行）
- 按插件 README 把包加入本机 dsh 的 profile 组合并填配置（频道 ID、仓库根映射、token 凭据引用），重启 dsh，确认 bot 在 #dsh-dispatch 显示在线。
