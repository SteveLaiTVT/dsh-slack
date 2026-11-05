/**
 * dsh-slack 插件主体：只做三件事——接单、执行（桥接 dsh）、交卷。
 * 不拦截、不审批工具执行（v0.4 起，用户定：个人项目场景摩擦大于收益）。
 * 形态对照 deepseek-harness cookbook 的 external protocol driver：
 *   inject = ['agents', 'sessions', 'sessionPersistence']（另加 cordis.patch.yml 的补丁行）。
 * 所有外部依赖（transport / bridge / channelContext）都可注入，集成测试用假实现跑全链。
 *
 * v0.3 路由口径（个人项目自用，零路由配置）：
 * - bot 被拉进的任何频道、workspace 内任何成员发的 [派单]/@bot 都接单；
 *   不做频道白名单、不做发送者白名单、不做频道→仓库映射。
 * - 每个频道首次接单时读一次频道上下文（主题/说明/近期消息）拼进 prompt，
 *   仓库与流程由 dsh 自己读上下文判断，需要时自己 clone——插件只当耳朵和嘴。
 */
import { DshBridge } from './bridge.js'
import { ChannelContextService } from './channel-context.js'
import { readTokens, validateConfig } from './config.js'
import { isDispatchText, parseDispatch, parseThreadCommand } from './parse.js'
import { TaskQueue } from './queue.js'
import { createRedactor, truncate } from './redact.js'
import { buildDispatchPrompt, buildReportCard, validateReport } from './render.js'
import { SlackTransport } from './transport.js'

export const PLUGIN_NAME = 'dsh-slack'
export const INJECT = ['agents', 'sessions', 'sessionPersistence']

const ACK_EMOJI = 'white_check_mark'
const REJECT_EMOJI = 'x'
const DENY_EMOJI = 'no_entry_sign'

/** 允许降级重发的 blocks 错误码，封闭名单。名单外不因「带了 blocks」而重发。 */
const BLOCKS_REJECT_CODES = new Set(['invalid_blocks', 'invalid_blocks_format'])
const UNCERTAIN_SLACK_CODES = new Set(['internal_error', 'fatal_error'])
const NETWORK_ERRNO = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
])

function deliveryLabel(delivery) {
  if (delivery === 'delivered') return '已送达'
  if (delivery === 'not_delivered') return '未送达'
  return '送达不确定'
}

function deliveryFromAttempt(attempt) {
  if (attempt.status === 'ok') return 'delivered'
  if (attempt.status === 'uncertain') return 'uncertain'
  return 'not_delivered'
}

/**
 * 未送达只限确定性拒绝（参数／权限／格式类错误码）。
 * internal_error／fatal_error 与超时／网络错误都是送达不确定，调用方不得因此重发。
 */
function classifyDeliveryError(error) {
  const slackCode = error?.data?.error
  if (isNetworkOrTimeout(error)) return { status: 'uncertain', code: slackCode }
  if (UNCERTAIN_SLACK_CODES.has(slackCode)) return { status: 'uncertain', code: slackCode }
  if (typeof slackCode === 'string' && slackCode.length > 0) return { status: 'rejected', code: slackCode }
  return { status: 'uncertain', code: undefined }
}

function isNetworkOrTimeout(error) {
  if (NETWORK_ERRNO.has(error?.code)) return true
  if (error?.name === 'AbortError') return true
  return /timeout|timed out|network|socket hang up|fetch failed|ECONN/i.test(String(error?.message ?? ''))
}

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
      const channelContext = deps.channelContext ?? new ChannelContextService({
        transport,
        messagesLimit: config.contextMessages,
        maxChars: config.contextMaxChars,
        refreshMs: config.contextRefreshMinutes * 60 * 1000,
      })
      const queue = new TaskQueue(config.queueLimit)
      const tasksByThread = new Map()
      const tasksBySession = new Map()
      const seenDispatches = new Set()

      const buildCard = deps.buildReportCard ?? buildReportCard

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
        // 频道初始化：读本频道主题/说明/近期消息作上下文（服务内有缓存），定仓与流程交给 dsh。
        let contextText = ''
        try {
          contextText = await channelContext.getContext(task.channelId)
        } catch (error) {
          log(`读频道上下文失败（继续开工）：${error?.message ?? error}`)
        }
        await post(task, `▶️ 已开工：session ${task.sessionId}。本频道的主题/说明/近期消息已作为上下文交给执行方，由它定仓开工。进度与结果回本 thread；发「[取消]」可中止。`)
        const prompt = buildDispatchPrompt(task, contextText)
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
        // 卡片在 buildReportCard 里已是终态：直送 transport，不走 post() 的 truncate(redact())。
        let delivery = 'uncertain'
        try {
          delivery = await deliverReport(task, finalText)
        } catch (error) {
          delivery = 'uncertain'
          log(`交卷发送异常：${error?.message ?? error}`)
        } finally {
          task.delivery = delivery
          log(`交卷送达状态：${deliveryLabel(delivery)}`)
          await advanceQueue(task)
        }
      }

      async function deliverReport(task, finalText) {
        const report = validateReport(finalText)
        let card
        try {
          card = buildCard({ report, originalText: finalText, redact })
        } catch (error) {
          log(`交卷卡片构造失败：${error?.message ?? error}`)
          const sent = await sendOnce(task, fallbackReportText(finalText))
          return deliveryFromAttempt(sent)
        }
        const first = await sendOnce(task, card.text, card.blocks)
        if (first.status === 'ok') return 'delivered'
        if (first.status === 'uncertain') return 'uncertain'
        if (BLOCKS_REJECT_CODES.has(first.code)) {
          const second = await sendOnce(task, card.text)
          return deliveryFromAttempt(second)
        }
        return 'not_delivered'
      }

      function fallbackReportText(finalText) {
        const body = truncate(redact(String(finalText ?? '')), 2800)
        return `⚠️ 交卷卡片构造失败，纯文本兜底：\n\n${body || '（无最终回复）'}`
      }

      async function sendOnce(task, text, blocks) {
        try {
          if (blocks == null) await transport.postMessage(task.channelId, text, task.threadTs)
          else await transport.postMessage(task.channelId, text, task.threadTs, blocks)
          return { status: 'ok' }
        } catch (error) {
          log(`回帖失败（thread ${task.threadTs}）：${error?.message ?? error}`)
          return classifyDeliveryError(error)
        }
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
        const task = {
          id: event.ts,
          channelId: event.channel,
          threadTs: event.ts,
          issueUrl: parsed.issueUrl,
          body: parsed.body,
          requesterId: event.user,
          sessionId: `slack-${event.ts.replace(/\./g, '')}`,
          cwd: config.workdir,
          workdir: config.workdir,
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
        const command = parseThreadCommand(event.text)
        if (command.kind === 'cancel') {
          await cancelTask(task, 'thread 指令')
          return
        }
        if (command.kind === 'status') {
          const active = queue.active
          await post(task, `📊 状态：当前执行中=${active ? `session ${active.sessionId}（频道 ${active.channelId}）` : '无'}；排队=${queue.waitingCount}；本单状态=${task.state}。`)
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
          if (transport.botUserId && event.user === transport.botUserId) return
          const inThread = event.threadTs !== undefined && event.threadTs !== event.ts
          if (inThread) {
            const task = tasksByThread.get(event.threadTs)
            if (!task) return
            await handleThreadMessage(event, task)
            return
          }
          if (seenDispatches.has(event.ts)) return
          if (!isDispatchText(event.text, transport.botUserId)) return
          await acceptDispatch(event)
        } catch (error) {
          log(`处理 Slack 消息出错：${error?.message ?? error}`)
        }
      })

      transport.onReaction(async (event) => {
        try {
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

      // v0.4：插件不拦截工具执行（无 tools/pre-execute 注册），dsh 按宿主默认策略运行。
      if (typeof ctx.on === 'function') {
        ctx.on('session/event', (session, event) => bridge.handleSessionEvent(session, event))
      }

      await transport.connect()
      log(`已连接 Slack，bot=${transport.botUserId ?? '?'}，模式=任意频道/任意成员接单，工作目录=${config.workdir}`)

      // 补扫：重连/启动后遍历 bot 已加入的频道，接管离线期间的派单（以 bot 的 ✅/❌ 反应为已处理标记）。
      let memberChannels = []
      try {
        memberChannels = (await transport.listMemberChannels?.()) ?? []
      } catch {
        memberChannels = []
      }
      for (const channelId of memberChannels) {
        try {
          const oldest = Math.floor(Date.now() / 1000) - config.rescanHours * 3600
          const history = await transport.history(channelId, oldest)
          const candidates = [...history].reverse()
          for (const message of candidates) {
            if (message.thread_ts && message.thread_ts !== message.ts) continue
            if (seenDispatches.has(message.ts)) continue
            if (!isDispatchText(message.text ?? '', transport.botUserId)) continue
            const ackedBy = await transport.getReactionUsers(channelId, message.ts, ACK_EMOJI)
            const rejectedBy = await transport.getReactionUsers(channelId, message.ts, REJECT_EMOJI)
            if (ackedBy.includes(transport.botUserId) || rejectedBy.includes(transport.botUserId)) {
              seenDispatches.add(message.ts)
              continue
            }
            await acceptDispatch(
              { channel: channelId, user: message.user, text: message.text ?? '', ts: message.ts, threadTs: undefined, isBot: false },
              { rescanned: true },
            )
          }
        } catch (error) {
          log(`补扫频道 ${channelId} 失败（不阻塞运行）：${error?.message ?? error}`)
        }
      }

      if (typeof ctx.on === 'function') {
        try {
          ctx.on('dispose', () => transport.disconnect())
        } catch { /* 个别宿主版本无 dispose 事件，忽略 */ }
      }
    },
  }
}
