/**
 * dsh-slack 插件主体：把 Slack 派单频道、任务队列、dsh 执行桥、人工审批四件套组装起来。
 * 形态对照 deepseek-harness cookbook 的 external protocol driver：
 *   inject = ['agents', 'sessions', 'sessionPersistence']（另加 cordis.patch.yml 的补丁行）。
 * 所有外部依赖（transport / bridge）都可注入，集成测试用假实现跑全链。
 */
import { ApprovalManager } from './approvals.js'
import { DshBridge } from './bridge.js'
import { readTokens, validateConfig } from './config.js'
import { isDispatchText, parseApprovalAnswer, parseDispatch, parseThreadCommand } from './parse.js'
import { evaluatePolicy, normalizeExec } from './policy.js'
import { TaskQueue } from './queue.js'
import { createRedactor, truncate } from './redact.js'
import { buildDispatchPrompt, validateReport } from './render.js'
import { SlackTransport } from './transport.js'

export const PLUGIN_NAME = 'dsh-slack'
export const INJECT = ['agents', 'sessions', 'sessionPersistence']

const ACK_EMOJI = 'white_check_mark'
const REJECT_EMOJI = 'x'
const DENY_EMOJI = 'no_entry_sign'

export function createSlackPlugin(deps = {}) {
  return {
    name: PLUGIN_NAME,
    inject: INJECT,

    async apply(ctx, rawConfig = {}) {
      const config = validateConfig(rawConfig)
      const tokens = deps.tokens ?? readTokens(config)
      const redact = createRedactor([tokens.appToken, tokens.botToken])
      const log = (msg) => (deps.logger ?? console).log?.(`[dsh-slack] ${redact(msg)}`)

      const transport = deps.transport ?? new SlackTransport(tokens)
      const queue = new TaskQueue(config.queueLimit)
      const tasksByThread = new Map()
      const tasksBySession = new Map()
      const seenDispatches = new Set()

      const approvals = new ApprovalManager({
        timeoutMs: config.approvalTimeoutMinutes * 60 * 1000,
      })

      const bridge = deps.bridge ?? new DshBridge({
        ctx,
        agentOptions: config.agentOptions,
        onSettled: (task, finalText) => {
          void settleTask(task, finalText)
        },
        onEventError: (error) => log(`session/event 处理出错：${error?.message ?? error}`),
      })

      const post = async (task, text) => {
        try {
          return await transport.postMessage(task.channelId, truncate(redact(text)), task.threadTs)
        } catch (error) {
          log(`回帖失败（thread ${task.threadTs}）：${error?.message ?? error}`)
          return undefined
        }
      }

      async function startTask(task) {
        task.state = 'active'
        tasksBySession.set(task.sessionId, task)
        await post(task, `▶️ 已开工：仓库 ${task.repo}，session ${task.sessionId}。进度与结果回本 thread；发「[取消]」可中止。`)
        const prompt = buildDispatchPrompt(task)
        const extra = task.bufferedTexts?.length
          ? `\n\n排队期间的补充：\n${task.bufferedTexts.join('\n')}`
          : ''
        try {
          await bridge.start(task, prompt + extra)
        } catch (error) {
          await post(task, `❌ 启动失败：${error?.message ?? error}`)
          await advanceQueue(task)
        }
      }

      async function settleTask(task, finalText) {
        if (task.state === 'cancelled' || task.state === 'done') return
        task.state = 'done'
        const report = validateReport(finalText)
        if (report.ok) {
          await post(task, `✅ 交卷（字段齐全）\n\n${finalText}`)
        } else {
          await post(task, `⚠️ 交卷不完整，缺：${report.missing.join('、')}。原文如下：\n\n${finalText || '（无最终回复）'}`)
        }
        await advanceQueue(task)
      }

      async function advanceQueue(finishedTask) {
        tasksBySession.delete(finishedTask.sessionId)
        const next = queue.finishActive()
        if (next) await startTask(next)
      }

      async function cancelTask(task, source) {
        if (task.state === 'queued') {
          queue.removeWaiting(t => t === task)
          task.state = 'cancelled'
          await post(task, `🛑 已取消（排队中，未执行）。来源：${source}`)
          return
        }
        if (task.state === 'active') {
          task.state = 'cancelled'
          bridge.cancel(task.sessionId)
          bridge.forget(task.sessionId)
          await post(task, `🛑 已取消正在执行的任务。来源：${source}`)
          await advanceQueue(task)
        }
      }

      async function acceptDispatch(event, { rescanned = false } = {}) {
        seenDispatches.add(event.ts)
        const parsed = parseDispatch(event.text)
        const threadAnchor = { channelId: event.channel, threadTs: event.ts }
        if (!parsed.repo || !(parsed.repo in config.repoRoots)) {
          await transport.postMessage(
            event.channel,
            `🚫 拒单：未识别仓库或仓库不在白名单。已配仓库：${Object.keys(config.repoRoots).join('、')}。请按「[派单] 仓库：<标识> Issue：<链接> 任务…」重发。`,
            event.ts,
          ).catch(() => {})
          await transport.addReaction(event.channel, event.ts, REJECT_EMOJI).catch(() => {})
          return
        }
        const task = {
          id: event.ts,
          channelId: event.channel,
          threadTs: event.ts,
          repo: parsed.repo,
          issueUrl: parsed.issueUrl,
          body: parsed.body,
          requesterId: event.user,
          sessionId: `slack-${event.ts.replace(/\./g, '')}`,
          cwd: config.repoRoots[parsed.repo],
          state: 'queued',
          bufferedTexts: [],
          rescanned,
        }
        const { position } = queue.enqueue(task)
        if (position === -1) {
          await transport.postMessage(event.channel, '🚫 队列已满，本单未受理，请稍后再派。', event.ts).catch(() => {})
          await transport.addReaction(event.channel, event.ts, REJECT_EMOJI).catch(() => {})
          return
        }
        tasksByThread.set(task.threadTs, task)
        await transport.addReaction(event.channel, event.ts, ACK_EMOJI).catch(() => {})
        if (position === 0) {
          await startTask(task)
        } else {
          await post(task, `${rescanned ? '🔁 补扫接单。' : '📥 已接单。'}当前有任务在执行，本单排队第 ${position} 位。`)
        }
      }

      async function handleThreadMessage(event, task) {
        // 审批作答优先于一切 thread 指令。
        if (approvals.hasPendingForThread(task.threadTs)) {
          const answer = parseApprovalAnswer(event.text)
          if (answer !== undefined) {
            approvals.resolveByThread(task.threadTs, answer)
            await post(task, answer ? '👍 已记录：准。' : '👎 已记录：驳。')
            return
          }
        }
        const command = parseThreadCommand(event.text)
        if (command.kind === 'cancel') {
          await cancelTask(task, 'thread 指令')
          return
        }
        if (command.kind === 'status') {
          const active = queue.active
          await post(task, `📊 状态：当前执行中=${active ? `${active.repo}（session ${active.sessionId}）` : '无'}；排队=${queue.waitingCount}；本单状态=${task.state}。`)
          return
        }
        if (task.state === 'active') {
          await bridge.followup(task.sessionId, command.text)
        } else if (task.state === 'queued') {
          task.bufferedTexts.push(command.text)
          await post(task, '📝 已记录为补充说明，开工时会一并带入。')
        }
      }

      transport.onMessage(async (event) => {
        try {
          if (event.isBot) return
          if (event.channel !== config.channelId) return
          if (transport.botUserId && event.user === transport.botUserId) return
          const inThread = event.threadTs !== undefined && event.threadTs !== event.ts
          if (inThread) {
            const task = tasksByThread.get(event.threadTs)
            if (!task) return
            if (!config.allowedUserIds.includes(event.user)) return
            await handleThreadMessage(event, task)
            return
          }
          if (!config.allowedUserIds.includes(event.user)) return
          if (seenDispatches.has(event.ts)) return
          if (!isDispatchText(event.text, transport.botUserId)) return
          await acceptDispatch(event)
        } catch (error) {
          log(`处理 Slack 消息出错：${error?.message ?? error}`)
        }
      })

      transport.onReaction(async (event) => {
        try {
          if (!config.allowedUserIds.includes(event.user)) return
          if (event.reaction === ACK_EMOJI || event.reaction === DENY_EMOJI) {
            const answer = event.reaction === ACK_EMOJI
            if (approvals.resolveByMessage(event.itemTs, answer)) return
          }
          if (event.reaction === DENY_EMOJI) {
            const task = tasksByThread.get(event.itemTs)
            if (task && (task.state === 'active' || task.state === 'queued')) {
              await cancelTask(task, '🚫 表情')
            }
          }
        } catch (error) {
          log(`处理 Slack 表情出错：${error?.message ?? error}`)
        }
      })

      // 工具权限网关：只管本插件名下 session 的执行，其余一律放行给宿主原有策略。
      if (typeof ctx.on === 'function') {
        ctx.on('tools/pre-execute', async (exec, next) => {
          const view = normalizeExec(exec)
          if (!view.sessionId) return next()
          const task = tasksBySession.get(view.sessionId)
          if (!task) return next()
          const verdict = evaluatePolicy(view, { repoRoots: config.repoRoots })
          if (verdict.action === 'allow') return next()
          if (verdict.action === 'deny') {
            await post(task, `⛔ 已硬拒绝一项操作：${verdict.reason}`)
            return { kind: 'deny', reason: verdict.reason }
          }
          const approved = await approvals.request({
            threadKey: task.threadTs,
            summary: verdict.reason,
            post: async (summary) => post(task, `⚠️ 审批请求：${summary}\n在 thread 回「准」/「驳」，或给本条加 ✅/🚫。${config.approvalTimeoutMinutes} 分钟未答按驳回处理。`),
          })
          if (!approved) return { kind: 'deny', reason: `人工审批未通过或超时：${verdict.reason}` }
          return next()
        })

        ctx.on('session/event', (session, event) => bridge.handleSessionEvent(session, event))
      }

      await transport.connect()
      log(`已连接 Slack，bot=${transport.botUserId ?? '?'}，频道=${config.channelId}`)

      // 补扫：重连/启动后接管离线期间的派单（以 bot 的 ✅/❌ 反应为已处理标记）。
      try {
        const oldest = Math.floor(Date.now() / 1000) - config.rescanHours * 3600
        const history = await transport.history(config.channelId, oldest)
        const candidates = [...history].reverse()
        for (const message of candidates) {
          if (message.thread_ts && message.thread_ts !== message.ts) continue
          if (!config.allowedUserIds.includes(message.user)) continue
          if (seenDispatches.has(message.ts)) continue
          if (!isDispatchText(message.text ?? '', transport.botUserId)) continue
          const ackedBy = await transport.getReactionUsers(config.channelId, message.ts, ACK_EMOJI)
          const rejectedBy = await transport.getReactionUsers(config.channelId, message.ts, REJECT_EMOJI)
          if (ackedBy.includes(transport.botUserId) || rejectedBy.includes(transport.botUserId)) {
            seenDispatches.add(message.ts)
            continue
          }
          await acceptDispatch(
            { channel: config.channelId, user: message.user, text: message.text ?? '', ts: message.ts, threadTs: undefined, isBot: false },
            { rescanned: true },
          )
        }
      } catch (error) {
        log(`补扫失败（不阻塞运行）：${error?.message ?? error}`)
      }

      if (typeof ctx.on === 'function') {
        try {
          ctx.on('dispose', () => transport.disconnect())
        } catch { /* 个别宿主版本无 dispose 事件，忽略 */ }
      }
    },
  }
}
