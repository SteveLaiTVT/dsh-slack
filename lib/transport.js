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
  /** 测试注入的 stub WebClient。只给 postMessage 用，connect 与其余方法仍走真实客户端。 */
  #stubWeb

  constructor({ appToken, botToken, webClient } = {}) {
    this.appToken = appToken
    this.botToken = botToken
    this.#stubWeb = webClient ?? null
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

  /**
   * blocks 可选。缺省时入参与现网纯文本一致（不带 blocks、不带 unfurl）。
   * 带 blocks 时附上 unfurl_links/unfurl_media=false，避免卡片里的 PR 链接被展开成预览。
   * stub WebClient（构造参数 webClient）优先于 connect() 建的客户端，供错误分类测试。
   */
  async postMessage(channel, text, threadTs, blocks) {
    const web = this.#stubWeb ?? this.#web
    const payload = {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }
    if (blocks != null) {
      payload.blocks = blocks
      payload.unfurl_links = false
      payload.unfurl_media = false
    }
    const res = await web.chat.postMessage(payload)
    // 官方客户端在 ok:false 时会抛；stub 可能直接返回 ok:false。两种都归一成带 data.error 的异常。
    if (res && res.ok === false) {
      const error = new Error(res.error || 'slack_api_error')
      error.data = res
      throw error
    }
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

  /** 频道信息：名称/主题/说明（频道上下文用）。失败返回 null，不阻塞接单。 */
  async fetchChannelInfo(channel) {
    try {
      const res = await this.#web.conversations.info({ channel })
      const ch = res.channel ?? {}
      return {
        id: ch.id ?? channel,
        name: ch.name,
        topic: ch.topic?.value ?? '',
        purpose: ch.purpose?.value ?? '',
      }
    } catch {
      return null
    }
  }

  /** 频道近期消息（旧→新，频道上下文用）。失败返回空数组。 */
  async fetchChannelMessages(channel, limit = 20) {
    try {
      const res = await this.#web.conversations.history({ channel, limit })
      return [...(res.messages ?? [])].reverse().map(m => ({
        user: m.user,
        text: m.text ?? '',
        ts: m.ts,
        isBot: Boolean(m.bot_id),
      }))
    } catch {
      return []
    }
  }

  /** bot 已加入的频道 id 列表（补扫遍历用）。失败返回空数组。 */
  async listMemberChannels() {
    try {
      const res = await this.#web.conversations.list({ types: 'public_channel,private_channel', limit: 200 })
      return (res.channels ?? []).filter(c => c.is_member).map(c => c.id)
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
