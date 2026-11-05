# dsh-slack —— DeepSeek Harness 的 Slack 渠道插件

让公司 Windows 上的 DeepSeek Harness（dsh）成为 Fluxion 工作区里的落户型 bot：在指定派单频道被 cue 接单、在本机仓库执行任务、进度与结果回帖 thread、按固定格式交卷。设计与验收标准见同目录 `SPEC.md`；装配步骤见 `SETUP.md`。

## 工作方式

- **连接**：Slack Socket Mode 出站长连接（不需要公网回调/内网穿透）。
- **接单**：只认配置频道内、配置发送者（工作区 owner 本人）的消息：`@dsh` 或以 `[派单]` 开头。正文格式：
  `[派单] 仓库：<标识> Issue：<链接> 任务描述…`（仓库标识必须在配置的 `repoRoots` 里，否则当场拒单并说明）
- **执行**：一个派单 = 一个 thread = 一个 dsh session；单任务串行，多的排队（上限可配）；thread 内发言即追问，`[取消]` 中止，发「状态」查进度。
- **交卷**：dsh 最后一条回复必须带 `## 交卷` 块（仓库/分支/Commit/PR/测试/AC 对照）；插件校验字段，缺项会回帖标注「交卷不完整」。
- **审批**：工具层三档策略——白名单内常规操作自动放行；git push、删除、装依赖、白名单外路径等在 thread 里转人工（回「准」/「驳」或给询问消息加 ✅/🚫，超时按驳回）；凭据类路径（`.ssh`、`.env`、`.pem` 等）硬拒绝。
- **补扫**：启动/重连后扫描频道近 24 小时（可配）消息，未被处理（无 bot 的 ✅/❌ 标记）的派单自动补接。
- **脱敏**：所有回帖与日志先过脱敏，Slack token 与登记秘密不出现（SPEC AC-10）。

## 配置

装入 dsh 的 profile 组合时按行配置（字段见 SPEC「配置项」）：

```yaml
- name: 'dsh-slack'
  config:
    channelId: 'C0XXXXXXXXX'          # 派单频道 ID
    allowedUserIds: ['U0ARCEG2T4K']   # 只认这些发送者
    repoRoots:
      demo: 'D:\repos\demo'           # repo 标识 -> 本机绝对路径（白名单根）
    # 可选：approvalTimeoutMinutes: 30, queueLimit: 5, rescanHours: 24
    # 可选：agentOptions: {}          # 透传给宿主 agents.create，一般留空走 dsh 默认模型
```

Token 不写配置：运行期从环境变量读——`DSH_SLACK_APP_TOKEN`（xapp-…）、`DSH_SLACK_BOT_TOKEN`（xoxb-…），变量名可用配置项 `appTokenEnv` / `botTokenEnv` 改。模型走宿主 dsh 的默认选择（建议 DeepSeek V4.1 Flash 1017 + dsh ≥ 0.2.1-rc.1，见 SPEC AC-11）。

## 本地开发与测试

```sh
npm install
npm test   # node --test，26 条，覆盖 SPEC 的 AC-02~AC-10（单元+集成，Slack 与宿主均为假件）
```

真实环境 E2E（AC-01/02/04/05/08 的在线版）需在公司机 dsh + 真实频道各跑一次，证据回填 SPEC 的验收记录区。

## 已知边界（v1）

- 交卷判定以「本任务全部 turn 收到 turn/end」为准，取最后一条 assistant 文本做字段校验；dsh 若在一条回复里分多次输出交卷块，以最后一条为准。
- 权限网关只拦截能归属到本插件 session 的工具执行（宿主 ToolExecution 需带 session 标识）；归属不明的执行一律放行给宿主原有策略，不误伤其他会话——这意味着宿主版本若不透出 session 标识，网关会整体失效，装配后请先按 AC-05/06 各验一次。
- `createUserMessage` 从宿主 `@deepseek-ai/dsh-llm` 动态导入；导入失败时用同形状纯数据兜底。
