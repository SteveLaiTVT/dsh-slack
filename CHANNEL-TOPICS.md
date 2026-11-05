# Fluxion 频道主题 / 说明（草稿，2026-11-05）

> 用途：每个频道一条「主题（Topic）」+ 一条「说明（Description）」，写清绑定仓库地址与开发流程，
> 与 dsh-slack v0.2 的 channelRepos 映射一一对应。Slack 主题上限 250 字，下文均在限内。
> 状态：连接器无设置主题的工具，待用户在 Slack 客户端粘贴，或浏览器登录 Slack 后由 Liu 代设。

## #cbec-software（C0CE20BENCS，dsh 绑仓频道）
- 主题：仓库 cbec-software｜上游 github.com/SteveLaiTVT/cbec-software｜下游 cnb.cool/stevelife524/cbec-software｜本频道绑仓，派单免写仓库名
- 说明：跨境电商平台（NestJS API＋React 管理端＋微信小程序＋contracts）。流程：需求先澄清 → CNB issue（AC/T/收尾模板）→ @CodeBuddy 实现 → PR → 人工合并 → 真实验证后关 issue。GitHub 为上游、CNB 为下游。

## #cbec-项目组（C0CE26TFLFL）
- 主题：cbec-software 项目组协同｜同仓 github.com/SteveLaiTVT/cbec-software（CNB：cnb.cool/stevelife524/cbec-software）
- 说明：项目组讨论与对齐用；代码与 issue 以同一 cbec-software 仓库为准，正式派单去 #cbec-software。流程同该频道：澄清 → issue 带 AC → 实现 → PR → 人工合并 → 验收关单。

## #ai-assistant（C0CDLNUCV0F，总控，不绑仓）
- 主题：ai-assistant 产品线总控｜仓库组 cnb.cool/stevelife524/ai-assistant（backend/mobile/esp32）及 ble-sim、vault、dsh-slack｜本频道不绑仓，派单写明仓库
- 说明：流程：Slack 讨论 → Liu 与 dot 对齐细节 → CNB issue 写满 spec＋AC 并冻结 → Codex/dsh 执行 → Liu 按 AC 核验 → 人工合并。一仓一频道建成后，单仓任务去对应绑仓频道派单。

## #ai-dev（C0ASM22EZ0Q，不绑仓）
- 主题：通用开发讨论｜不绑仓；正式派单请到对应仓库频道，或在本频道写明仓库＋issue 链接
- 说明：临时开发讨论与试验区。正式任务走对应项目频道＋CNB issue（spec/AC 冻结后再执行）；本频道形成的结论请同步回项目频道存档。
