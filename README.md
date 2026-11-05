# dsh-slack —— DeepSeek Harness 的 Slack 渠道插件

让公司 Windows 上的 DeepSeek Harness（dsh）成为 Fluxion 工作区里的落户型 bot：在任何频道被 cue 接单、在本机执行任务、进度与结果回帖 thread、按固定格式交卷。**v0.3 起零路由配置：bot 在的任何频道、任何成员都能派单；每个频道首次接单时插件自动读取该频道的主题/说明/近期消息作为上下文交给 dsh，仓库与流程规范由 dsh 读上下文自行判断（需要时自己 clone），插件不做频道→仓库映射、不代拉仓库。**设计与验收标准见同目录 `SPEC.md`；装配步骤见 `SETUP.md`。

## 工作方式

- **连接**：Slack Socket Mode 出站长连接（不需要公网回调/内网穿透）。
- **接单**：bot 被拉进的任何频道内，任何成员 `@dsh` 或以 `[派单]` 开头发言即接单。个人项目自用，不做频道/发送者白名单。
- **频道上下文（定仓的依据）**：频道首次接单时，插件读该频道的主题（topic）、说明（purpose）与近期消息（默认 20 条），拼成上下文块随任务一起交给 dsh——在频道主题/说明里写明仓库地址与开发流程规范，dsh 就会按它定仓、拉仓、守流程。上下文按频道缓存，主题/说明变化或超过刷新间隔（默认 60 分钟）时重读。读不到（缺权限等）不阻塞接单，只是上下文为空。
- **执行**：一个派单 = 一个 thread = 一个 dsh session；session 的工作目录是统一的 `workdir`，dsh 在它下面 clone/进仓干活。单任务串行，多的排队（上限可配）；thread 内发言即追问，`[取消]` 中止，发「状态」查进度。
- **交卷**：dsh 最后一条回复必须带 `## 交卷` 块（仓库/分支/Commit/PR/测试/AC 对照，仓库填实际使用的）；插件校验字段，缺项会回帖标注「交卷不完整」。
- **审批**：工具层三档策略——`workdir` 内常规操作自动放行；git push、删除、装依赖、workdir 外路径等在 thread 里转人工（回「准」/「驳」或给询问消息加 ✅/🚫，超时按驳回）；凭据类路径（`.ssh`、`.env`、`.pem` 等）硬拒绝。
- **补扫**：启动/重连后遍历 bot 已加入的频道，扫描近 24 小时（可配）消息，未被处理（无 bot 的 ✅/❌ 标记）的派单自动补接。
- **脱敏**：所有回帖与日志先过脱敏，Slack token 与登记秘密不出现（SPEC AC-10）。

## 配置

v0.3 的配置只剩可选项，全部留空也能跑（`workdir` 默认取 dsh 进程的工作目录）：

```yaml
- name: 'dsh-slack'
  config:
    workdir: 'D:\dsh-work'   # 可选：统一工作目录 + 权限白名单根
    # 可选：approvalTimeoutMinutes: 30, queueLimit: 5, rescanHours: 24
    # 可选：contextMessages: 20, contextMaxChars: 6000, contextRefreshMinutes: 60
    # 可选：agentOptions: {}   # 透传给宿主 agents.create，一般留空走 dsh 默认模型
```

v0.1/v0.2 的旧字段（`allowedUserIds`、`channelRepos`、`channelId`、`repoRoots`）出现会被直接忽略，老配置无需改动即可启动。

Token 不写配置：运行期从环境变量读——`DSH_SLACK_APP_TOKEN`（xapp-…）、`DSH_SLACK_BOT_TOKEN`（xoxb-…），变量名可用配置项 `appTokenEnv` / `botTokenEnv` 改。模型走宿主 dsh 的默认选择（建议 DeepSeek V4.1 Flash 1017 + dsh ≥ 0.2.1-rc.1，见 SPEC AC-11）。

频道主题/说明的推荐写法（仓库地址 + 流程规范各一行起头），各频道现行稿子见 `CHANNEL-TOPICS.md`。

## 本地开发与测试

```sh
npm install
npm test   # node --test，31 条，覆盖 SPEC 的 AC-02~AC-10 与 AC-14/AC-15（单元+集成，Slack 与宿主均为假件）
```

真实环境 E2E（AC-01/02/04/05/08 的在线版）需在公司机 dsh + 真实频道各跑一次，证据回填 SPEC 的验收记录区。

## 已知边界（v1）

- 交卷判定以「本任务全部 turn 收到 turn/end」为准，取最后一条 assistant 文本做字段校验；dsh 若在一条回复里分多次输出交卷块，以最后一条为准。
- 权限网关只拦截能归属到本插件 session 的工具执行（宿主 ToolExecution 需带 session 标识）；归属不明的执行一律放行给宿主原有策略，不误伤其他会话——这意味着宿主版本若不透出 session 标识，网关会整体失效，装配后请先按 AC-05/06 各验一次。
- `createUserMessage` 从宿主 `@deepseek-ai/dsh-llm` 动态导入；导入失败时用同形状纯数据兜底。
- 任何成员可派单是个人项目的既定口径（用户 2026-11-05 定）；若日后工作区进外人，先收紧接单范围再放量。
