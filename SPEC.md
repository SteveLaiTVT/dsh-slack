# dsh Slack 插件 Spec v0.3（2026-11-05，Liu 起草；v0.2 增补频道→仓库映射，v0.3 改为零路由配置 + 频道上下文定仓，用户当日指示）

## 背景与目标
公司 Windows 上已有 DeepSeek Harness（dsh）在运行，但 dsh 无任何消息渠道组件，无法从 Slack 被 cue、被派单。本插件把 dsh 变成 Fluxion 工作区里的**落户型 bot**：在指定频道被 @ 或收到派单格式消息后接单，在本机仓库执行任务，进度与结果回帖到 thread，交卷标准与既有派单纪律一致（没 push 不算完成）。

上游流程（已定）：用户提需求 → Liu 与 dot 在 Slack 对细节 → CNB issue 写满 spec/AC 并冻结 → cue 本插件背后的 dsh 执行 → Liu 按 AC 核验 → 用户合并。

## 技术基座（已查证，源自 deepseek-harness 官方 cookbook 与 ACP 包）
- 插件形态：标准 dsh 插件 npm 包（ESM，Node ≥22），导出 `name` / `inject` / `apply(ctx, config)`，配置走 schemastery schema；生态规范见同类插件（如 dsh-moyu-break）。
- 插件类型按 cookbook 的 **external protocol driver** 写：`inject = ['agents', 'sessions', 'sessionPersistence']`；入站 prompt → 工厂建/恢复 agent → `followup()` 投喂并拿回执；出站订阅 `session/event`（assistant/message、turn 边界、工具活动）；`steer()` 追问、`cancel()` 取消、`AgentHandle.dispose()` 收尾。ACP 包（packages/acp）为官方同类范例，实现时对照其 README 的生命周期契约。
- 权限：`tools/pre-execute` 可返回 `ask` 并经 `ctx.approval` 回答；ACP 范例注册了「one-shot machine permission answerer」。本插件按下方权限策略实现自己的 answerer。

## 范围（v1）
1. **连接**：Slack Socket Mode（App-Level Token `xapp` 建出站长连接；Bot Token `xoxb` 调 Web API）。断线自动重连（指数退避），重连后补扫（见 7）。
2. **接单面（v0.3 改版）**：bot 被拉进的**任何频道**、workspace 内**任何成员**的消息都可接单（个人项目自用，用户 2026-11-05 定，不做频道/发送者白名单）。两种触发：@bot，或以 `[派单]` 开头的消息。正文须含 issue 链接或完整任务描述；插件在原消息开 thread 回「已接单」并绑定 session。bot 自身与其它 bot 的消息不响应。
2b. **频道上下文定仓（v0.3，取代 v0.2 的频道→仓库映射）**：频道首次接单时，插件读取该频道的主题（topic）、说明（purpose）与近期消息（默认 20 条），拼成上下文块随首条 prompt 交给 dsh；仓库地址与开发流程规范写在频道主题/说明里，**由 dsh 读上下文自行定仓**，仓库不在本机时由 dsh 自己在 `workdir` 下 clone、已在则 pull——插件不做映射、不解析仓库、不代拉仓。上下文按频道缓存，主题/说明变化或超过刷新间隔（默认 60 分钟）时重读；读取失败（缺权限等）不阻塞接单，上下文为空块继续开工。（v0.2 的 `channelRepos` 映射与开工前同步就此废止，AC-12/AC-13 同步废止。）
3. **执行**：按 thread 建一个 dsh session，工作目录为统一 `workdir`（默认 dsh 进程 cwd），dsh 在它下面 clone/进仓干活。默认模型 `deepseek-v4.1-flash`（1017），reasoning effort 默认 high，配置可改。
4. **进度回帖**：只在关键节点回帖（开始、需要审批、阶段完成、失败、交卷），不逐 token 刷屏；长输出截断并附本地日志路径。
5. **追问与取消**：同一 thread 内的后续消息 → `steer()`/`followup()` 进同一 session；消息 `[取消]` 或对接单消息加 🚫 表情 → `cancel()` 并回帖确认。
6. **交卷**：turn 结束后回帖固定格式：仓库、分支名、完整 commit hash、PR 链接（或「未建 PR」原因）、测试结果摘要（命令＋通过/失败数）、与 AC 的逐条对照（由 dsh 在 session 内按派单要求自填，插件只负责搬运与格式校验，缺字段时回帖标红「交卷不完整」）。
7. **补扫**：启动/重连时遍历 bot 已加入的全部频道，扫描最近 24 小时内、任何成员发出、且没有「已接单」标记的派单消息，按时间顺序逐个接单（受单任务锁约束排队）。
8. **权限策略**：三档——
   - 自动放行：`workdir` 根目录内的文件读写、git status/diff/log、跑测试与构建命令；
   - 转人工：git push、删除文件、安装依赖、访问 `workdir` 外路径、外网络请求——插件在 thread 发起询问，任何成员回「准」/「驳」或加 ✅/🚫 表情作答，默认等 30 分钟超时按驳回处理；
   - 硬拒绝：凭据目录/文件（`.ssh`、`.env`、`.pem`、dsh credentials 等）读取，直接拒绝并回帖记录。
9. **单任务锁与队列**：同时只跑一个 session；新派单排队并回帖告知位次；队列上限 5，超限拒单。
10. **状态与日志**：在 thread 回「状态」类 cue 时报告当前任务与队列；运行日志落本机文件（按日滚动），不回帖敏感内容（token、密钥一律不出现在日志与回帖中）。

## 非目标（v1 不做）
- 多 session 并行（队列仍全局串行）、Slack 文件附件入站、Canvas 汇报、定时任务、把结果同步回 CNB issue 评论（v2 再议）。多仓定仓由 dsh 依频道上下文自行处理（见范围 2b），插件不做路由，不在非目标内。

## 配置项（schema，随插件包交付）
token 只走环境变量（`DSH_SLACK_APP_TOKEN` / `DSH_SLACK_BOT_TOKEN`，变量名可配），不落明文配置。可选配置全部有默认值、整段留空可启动：`workdir`（统一工作目录兼权限白名单根，默认进程 cwd）、`approvalTimeoutMinutes=30`、`queueLimit=5`、`rescanHours=24`、`contextMessages=20`、`contextMaxChars=6000`、`contextRefreshMinutes=60`、`agentOptions`（透传宿主）。v0.1/v0.2 旧字段（`allowedUserIds`、`channelRepos`、`channelId`、`repoRoots`）出现即忽略。

## 验收标准（AC）
- AC-01 插件装入 dsh profile 后 dsh 正常启动，插件建立 Socket Mode 连接，Slack 侧 bot 显示在线。
- AC-02 用户在任一 bot 所在频道 @bot 发一条含测试 issue 链接的派单，60 秒内原消息下出现「已接单」thread 且 session 建立；bot 自身消息与普通聊天消息无任何反应。（v0.3 修订：原「非配置发送者/频道无反应」口径废止，见 AC-14。）
- AC-03 执行中 thread 追问一句，内容进入同一 session（dsh 侧 transcript 可见同一 session 两条用户消息）。
- AC-04 任务完成，交卷回帖六项字段齐全（仓库/分支/commit hash/PR/测试摘要/AC 对照）；故意造一个缺 PR 的任务，回帖标注「交卷不完整」。
- AC-05 触发一条需 push 的动作时先出现审批询问；用户回「驳」后动作不执行且 session 收到拒绝理由；回「准」后执行。
- AC-06 硬拒绝验证：派单要求读取 `.ssh` 下文件，插件直接拒绝并回帖记录，session 不执行该读取。
- AC-07 并发：连发两条派单，第二条回帖显示排队位次 1；第一条结束后第二条自动开始。
- AC-08 断网/重启 dsh 后，离线期间发出的一条派单在重连补扫后被接单（有「补扫接单」标识）。
- AC-09 `[取消]` 能中止正在跑的任务并回帖确认，session 状态为 cancelled。
- AC-10 全量日志与回帖中检索不到 `xoxb`/`xapp` 明文与任何凭据值。
- AC-11 dsh 版本前置：宿主 dsh ≥ 0.2.1-rc.1 且模型为 V4.1-Flash-1017 时全量 AC 通过（版本不符先升级再验，此为开工前置检查项，由用户在公司机确认）。
- AC-12（v0.3 废止）频道→仓库映射：两个绑定不同仓库的频道各派一单（均不写「仓库：」），session 的 cwd 与 prompt 中的仓库分别对应该频道绑定仓；绑定频道里写了别的仓库被拒单且不建 session；未映射频道的派单无任何反应。
- AC-13（v0.3 废止）按频道拉仓：绑定仓本地缺失且映射配了 remote 时开工前完成 clone；已存在时开工前完成 `pull --ff-only`；clone/pull 失败时回帖「仓库同步失败」且不开工、队列继续推进。
- AC-14 零路由配置接单：插件配置整段留空（仅 token 环境变量）启动后，在两个从未配置过的频道、由两个不同成员各派一单，均被接单（第二单排队）；session 的 cwd 均为统一 `workdir`。
- AC-15 频道初始化读上下文：某频道首次接单时，首条 prompt 中包含该频道的主题、说明与近期消息（上下文块）；同频道后续派单复用缓存不重复读取（主题/说明不变且未过刷新间隔）；修改频道主题后，下一单的 prompt 带上新主题。读取失败时仍能接单开工（上下文为空块）。
- AC-16 插件不定仓：插件代码与配置中不存在频道→仓库映射与代拉仓逻辑（`lib/repos.js` 已删）；定仓、clone/pull 由 dsh 依上下文执行，交卷中的仓库字段为 dsh 实际使用的仓库。

## 测试映射
单元测试（node --test）：派单解析、白名单校验、队列/锁、交卷字段校验、补扫去重。集成测试：用假 Slack 事件注入 + 假 agents 服务跑通接单→执行→交卷链。E2E：AC-02/04/05/08 在真实 Fluxion 派单频道 + 公司机 dsh 上各跑一次，证据（thread 链接、commit、PR）回填本 spec 的验收记录区。

## 验收记录区（执行后回填）
- 2026-11-05（Liu 于本机 VM）：v0.3 零配置化改造完成（用户指示：初始化频道时读频道内容让 dsh 自己定仓、任何频道任何成员可 cue、不用配置那么多）。删除 `lib/repos.js` 与频道映射/发送者白名单全套逻辑；新增 `lib/channel-context.js`（主题/说明/近期消息读取 + 缓存 + 主题变化刷新 + 容错）；transport 增 conversations.info/history/list 三个读接口；权限白名单根收敛为单一 `workdir`。单元+集成测试 31/31 全绿（`npm test`，Liu 本机复跑），覆盖 AC-14（双频道双成员接单）、AC-15（上下文注入/缓存/主题变化重读/容错）与 AC-16（映射代码已删，由结构保证），AC-02/03/04/05/06/07/08/09 回归通过。真实频道 E2E 待公司机装配后验（SETUP 第 4 步的冒烟单即 AC-01/14/15 在线版）。
- 2026-11-05（Liu 于本机 VM）：v0.2 频道→仓库映射实现完成（用户指示「针对不同的频道拉取不同的仓库」）。新增 `lib/repos.js`（clone/pull 同步）、config 的 `channelRepos`/`channels` 归一化与防串仓校验、plugin 按频道路由与开工前同步。单元+集成测试 33/33 全绿（`npm test`，Liu 本机复跑），新增覆盖 AC-12（双频道路由/防串仓/未映射频道无反应）、AC-13（clone/pull/同步失败不开工）。真实频道 E2E 待公司机装配后随 AC-01 一并验。
- 2026-11-05（Liu 于本机 VM）：插件本体实现完成（用户改令由 Liu 直接实现，取代原 Codex 派发）。单元+集成测试 26/26 全绿（`npm test`，Slack 与宿主均为假件），覆盖 AC-02（接单/反面）、AC-03、AC-04、AC-05、AC-06、AC-07、AC-08、AC-09、AC-10；依赖安装与入口加载冒烟通过。
- 待验（需真实环境）：AC-01（公司机 dsh 装入后 bot 在线）、AC-11（dsh ≥ 0.2.1-rc.1 + 模型 1017 前置确认），以及 AC-02/04/05/08 的真实频道 E2E 各一次。注意 README「已知边界」：权限网关依赖宿主 ToolExecution 透出 session 标识，装配后先验 AC-05/06 再放量。
