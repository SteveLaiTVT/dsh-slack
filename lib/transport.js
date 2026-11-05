/**
 * Slack 传输层（Socket Mode）：插件与 Slack 之间的唯一出入口，接口刻意做小，
 * 测试用假实现替换。事件统一归一化为：
 *   message:    { kind: 'message', channel, user, text, ts, threadTs, isBot }
 *   reaction:   { kind: 'reaction', channel, user, reaction, itemTs, threadTs: undefined }
 * 应答 Socket Mode 信封由库的 ack 负责，这里对每个事件先 ack 再分发。
 */
export class SlackTransport {
  #web
  #socket
  #botUserId

  constructor({ appToken, botToken }) {
    this.appToken = appToken
    this.botToken = botToken
    this.messageHandlers = []
    this.reactionHandlers = []
  }

  onMessage(handler) {
    this.messageHandlers.push(handler)
  }

  onReaction(handler) {
    this.reactionHandlers.push(handler)
  }

  get botUserId() {
    return this.#botUserId
  }

  async connect() {
    const [{ SocketModeClient }, { WebClient }] = await Promise.all([
      import('@slack/socket-mode'),
      import('@slack/web-api'),
    ])
    this.#web = new WebClient(this.botToken)
    const auth = await this.#web.auth.test()
    this.#botUserId = auth.user_id

    this.#socket = new SocketModeClient({ appToken: this.appToken })
    const dispatch = async (envelope, event) => {
      try {
        await envelope.ack?.()
      } catch { /* ack 失败不阻塞分发 */ }
      if (event?.type === 'message' || event?.type === 'app_mention') {
        const normalized = {
          kind: 'message',
          channel: event.channel,
          user: event.user,
          text: event.text ?? '',
          ts: event.ts,
          threadTs: event.thread_ts,
          isBot: Boolean(event.bot_id) || event.subtype === 'bot_message',
        }
        for (const handler of this.messageHandlers) await handler(normalized)
      } else if (event?.type === 'reaction_added') {
        const normalized = {
          kind: 'reaction',
          channel: event.item?.channel,
          user: event.user,
          reaction: event.reaction,
          itemTs: event.item?.ts,
        }
        for (const handler of this.reactionHandlers) await handler(normalized)
      }
    }
    this.#socket.on('message', async args => dispatch(args, args.event))
    this.#socket.on('app_mention', async args => dispatch(args, args.event))
    this.#socket.on('reaction_added', async args => dispatch(args, args.event))
    this.#socket.on('slack_event', async args => {
      // 兜底：未单独注册的事件类型至少把信封 ack 掉，避免 Slack 重投。
      try {
        await args.ack?.()
      } catch { /* ignore */ }
    })
    await this.#socket.start()
    return this
  }

  async disconnect() {
    await this.#socket?.disconnect?.()
  }

  async postMessage(channel, text, threadTs) {
    const res = await this.#web.chat.postMessage({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    })
    return res.ts
  }

  async addReaction(channel, timestamp, name) {
    await this.#web.reactions.add({ channel, timestamp, name })
  }

  /** 取某条消息上某 emoji 的点选者（含 bot 自己，用于补扫去重）。 */
  async getReactionUsers(channel, timestamp, name) {
    try {
      const res = await this.#web.reactions.get({ channel, timestamp })
      const entry = (res.message?.reactions ?? []).find(r => r.name === name)
      return entry?.users ?? []
    } catch {
      return []
    }
  }

  /** 拉频道历史（补扫用），oldest 为 unix 秒。 */
  async history(channel, oldestSec, limit = 100) {
    const res = await this.#web.conversations.history({
      channel,
      oldest: String(oldestSec),
      limit,
    })
    return res.messages ?? []
  }
}
