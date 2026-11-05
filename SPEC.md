# dsh Slack 插件 Spec v0.1（2026-11-05，Liu 起草，待用户确认后冻结）

## 背景与目标
公司 Windows 上已有 DeepSeek Harness（dsh）在运行，但 dsh 无任何消息渠道组件，无法从 Slack 被 cue、被派单。本插件把 dsh 变成 Fluxion 工作区里的**落户型 bot**：在指定频道被 @ 或收到派单格式消息后接单，在本机仓库执行任务，进度与结果回帖到 thread，交卷标准与既有派单纪律一致（没 push 不算完成）。

上游流程（已定）：用户提需求 → Liu 与 dot 在 Slack 对细节 → CNB issue 写满 spec/AC 并冻结 → cue 本插件背后的 dsh 执行 → Liu 按 AC 核验 → 用户合并。

## 技术基座（已查证，源自 deepseek-harness 官方 cookbook 与 ACP 包）
- 插件形态：标准 dsh 插件 npm 包（ESM，Node ≥22），导出 `name` / `inject` / `apply(ctx, config)`，配置走 schemastery schema；生态规范见同类插件（如 dsh-moyu-break）。
- 插件类型按 cookbook 的 **external protocol driver** 写：`inject = ['agents', 'sessions', 'sessionPersistence']`；入站 prompt → 工厂建/恢复 agent → `followup()` 投喂并拿回执；出站订阅 `session/event`（assistant/message、turn 边界、工具活动）；`steer()` 追问、`cancel()` 取消、`AgentHandle.dispose()` 收尾。ACP 包（packages/acp）为官方同类范例，实现时对照其 README 的生命周期契约。
- 权限：`tools/pre-execute` 可返回 `ask` 并经 `ctx.approval` 回答；ACP 范例注册了「one-shot machine permission answerer」。本插件按下方权限策略实现自己的 answerer。

## 范围（v1）
1. **连接**：Slack Socket Mode（App-Level Token `xapp` 建出站长连接；Bot Token `xoxb` 调 Web API）。断线自动重连（指数退避），重连后补扫（见 7）。
2. **接单面**：仅响应配置频道（v1 只配一个派单频道）内、配置发送者（用户本人 Slack ID `U0ARCEG2T4K`）的消息。两种触发：@bot，或以 `[派单]` 开头的消息。正文须含 issue 链接或完整任务描述；插件在原消息开 thread 回「已接单」并绑定 session。
3. **执行**：按 thread 建一个 dsh session，工作目录从派单中的仓库标识映射到本机白名单根目录（如 `D:\repos\<repo>`，映射表在配置里，表外仓库直接拒单并回帖说明）。默认模型 `deepseek-v4.1-flash`（1017），reasoning effort 默认 high，配置可改。
4. **进度回帖**：只在关键节点回帖（开始、需要审批、阶段完成、失败、交卷），不逐 token 刷屏；长输出截断并附本地日志路径。
5. **追问与取消**：同一 thread 内的后续消息 → `steer()`/`followup()` 进同一 session；消息 `[取消]` 或对接单消息加 🚫 表情 → `cancel()` 并回帖确认。
6. **交卷**：turn 结束后回帖固定格式：仓库、分支名、完整 commit hash、PR 链接（或「未建 PR」原因）、测试结果摘要（命令＋通过/失败数）、与 AC 的逐条对照（由 dsh 在 session 内按派单要求自填，插件只负责搬运与格式校验，缺字段时回帖标红「交卷不完整」）。
7. **补扫**：启动/重连时扫描派单频道最近 24 小时内、由配置发送者发出、且没有「已接单」标记的派单消息，按时间顺序逐个接单（受单任务锁约束排队）。
8. **权限策略**：三档——
   - 自动放行：白名单根目录内的文件读写、git status/diff/log、跑测试与构建命令；
   - 转人工：git push、删除文件、安装依赖、访问白名单外路径、白名单外网络请求——插件在 thread 发起询问，用户回「准」/「驳」或加 ✅/🚫 表情作答，默认等 30 分钟超时按驳回处理；
   - 硬拒绝：白名单根之外的写入、凭据目录（`.ssh`、dsh credentials 等）读取，直接拒绝并回帖记录。
9. **单任务锁与队列**：同时只跑一个 session；新派单排队并回帖告知位次；队列上限 5，超限拒单。
10. **状态与日志**：在 thread 回「状态」类 cue 时报告当前任务与队列；运行日志落本机文件（按日滚动），不回帖敏感内容（token、密钥一律不出现在日志与回帖中）。

## 非目标（v1 不做）
- 多 session 并行、多频道多仓路由、Slack 文件附件入站、Canvas 汇报、定时任务、把结果同步回 CNB issue 评论（v2 再议）。

## 配置项（schema，随插件包交付）
`appToken`（凭据引用，不落明文配置）、`botToken`（同）、`channelId`、`allowedUserIds[]`、`repoRoots{ repo标识: 绝对路径 }`、`model`、`reasoningEffort`、`approvalTimeoutMinutes=30`、`queueLimit=5`、`logDir`。

## 验收标准（AC）
- AC-01 插件装入 dsh profile 后 dsh 正常启动，插件建立 Socket Mode 连接，Slack 侧 bot 显示在线。
- AC-02 用户在派单频道 @bot 发一条含测试 issue 链接的派单，60 秒内原消息下出现「已接单」thread 且 session 建立；非配置发送者、非配置频道的消息无任何反应。
- AC-03 执行中 thread 追问一句，内容进入同一 session（dsh 侧 transcript 可见同一 session 两条用户消息）。
- AC-04 任务完成，交卷回帖六项字段齐全（仓库/分支/commit hash/PR/测试摘要/AC 对照）；故意造一个缺 PR 的任务，回帖标注「交卷不完整」。
- AC-05 触发一条需 push 的动作时先出现审批询问；用户回「驳」后动作不执行且 session 收到拒绝理由；回「准」后执行。
- AC-06 硬拒绝验证：派单要求读取 `.ssh` 下文件，插件直接拒绝并回帖记录，session 不执行该读取。
- AC-07 并发：连发两条派单，第二条回帖显示排队位次 1；第一条结束后第二条自动开始。
- AC-08 断网/重启 dsh 后，离线期间发出的一条派单在重连补扫后被接单（有「补扫接单」标识）。
- AC-09 `[取消]` 能中止正在跑的任务并回帖确认，session 状态为 cancelled。
- AC-10 全量日志与回帖中检索不到 `xoxb`/`xapp` 明文与任何凭据值。
- AC-11 dsh 版本前置：宿主 dsh ≥ 0.2.1-rc.1 且模型为 V4.1-Flash-1017 时全量 AC 通过（版本不符先升级再验，此为开工前置检查项，由用户在公司机确认）。

## 测试映射
单元测试（node --test）：派单解析、白名单校验、队列/锁、交卷字段校验、补扫去重。集成测试：用假 Slack 事件注入 + 假 agents 服务跑通接单→执行→交卷链。E2E：AC-02/04/05/08 在真实 Fluxion 派单频道 + 公司机 dsh 上各跑一次，证据（thread 链接、commit、PR）回填本 spec 的验收记录区。

## 验收记录区（执行后回填）
- 2026-11-05（Liu 于本机 VM）：插件本体实现完成（用户改令由 Liu 直接实现，取代原 Codex 派发）。单元+集成测试 26/26 全绿（`npm test`，Slack 与宿主均为假件），覆盖 AC-02（接单/反面）、AC-03、AC-04、AC-05、AC-06、AC-07、AC-08、AC-09、AC-10；依赖安装与入口加载冒烟通过。
- 待验（需真实环境）：AC-01（公司机 dsh 装入后 bot 在线）、AC-11（dsh ≥ 0.2.1-rc.1 + 模型 1017 前置确认），以及 AC-02/04/05/08 的真实频道 E2E 各一次。注意 README「已知边界」：权限网关依赖宿主 ToolExecution 透出 session 标识，装配后先验 AC-05/06 再放量。
