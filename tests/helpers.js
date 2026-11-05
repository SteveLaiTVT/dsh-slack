/** 测试假件：假 Slack 传输 + 假 dsh 宿主 ctx，形状对齐真实接口（见 lib/transport.js 与 ACP 实现）。 */

export class FakeTransport {
  constructor() {
    this.botUserId = 'UBOT'
    this.posts = [] // { channel, text, threadTs, ts }
    this.reactionsAdded = [] // { channel, timestamp, name }
    this.historyData = []
    this.reactionUsers = new Map() // `${ts}:${name}` -> [userIds]
    this.messageHandlers = []
    this.reactionHandlers = []
    this.postSeq = 0
  }

  onMessage(h) {
    this.messageHandlers.push(h)
  }

  onReaction(h) {
    this.reactionHandlers.push(h)
  }

  async connect() {
    return this
  }

  async disconnect() {}

  async postMessage(channel, text, threadTs) {
    const ts = `p${++this.postSeq}`
    this.posts.push({ channel, text, threadTs, ts })
    return ts
  }

  async addReaction(channel, timestamp, name) {
    this.reactionsAdded.push({ channel, timestamp, name })
  }

  async getReactionUsers(channel, timestamp, name) {
    return this.reactionUsers.get(`${timestamp}:${name}`) ?? []
  }

  async history() {
    return this.historyData
  }

  async emitMessage(event) {
    for (const h of this.messageHandlers) await h(event)
  }

  async emitReaction(event) {
    for (const h of this.reactionHandlers) await h(event)
  }

  postsInThread(threadTs) {
    return this.posts.filter(p => p.threadTs === threadTs)
  }
}

export class FakeAgent {
  constructor(sessionId) {
    this.id = `agent-${sessionId}`
    this.session = { id: sessionId }
    this.followups = [] // 每条是纯文本
    this.cancelCalls = []
  }

  followup(message) {
    const text = (message?.content ?? [])
      .filter(c => c?.type === 'text')
      .map(c => c.text)
      .join('')
    this.followups.push(text)
  }

  cancel(options) {
    this.cancelCalls.push(options)
  }
}

export class FakeCtx {
  constructor() {
    this.handlers = new Map()
    this.createdAgents = [] // { sessionId, cwd, agent }
    this.sessions = {
      get: () => undefined,
    }
    this.agents = {
      create: async ({ sessionId, meta }) => {
        const agent = new FakeAgent(sessionId)
        this.createdAgents.push({ sessionId, cwd: meta?.cwd, agent })
        return { agent, dispose: async () => {} }
      },
      resume: async () => {
        throw new Error('测试中不走 resume')
      },
      get: () => undefined,
    }
  }

  on(event, handler) {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {}
  }

  async emitSessionEvent(sessionId, event) {
    for (const h of this.handlers.get('session/event') ?? []) {
      h({ id: sessionId }, event)
    }
  }

  async runPreExecute(exec) {
    const handler = (this.handlers.get('tools/pre-execute') ?? [])[0]
    if (!handler) throw new Error('插件未注册 tools/pre-execute')
    return handler(exec, async () => ({ kind: 'next' }))
  }
}

export const TEST_CONFIG = {
  channelId: 'C1',
  allowedUserIds: ['U1'],
  repoRoots: { demo: 'D:/repos/demo' },
}

export function dispatchEvent(overrides = {}) {
  return {
    kind: 'message',
    channel: 'C1',
    user: 'U1',
    text: '[派单] 仓库：demo Issue：https://cnb.cool/x/demo/issues/1 把登录页按钮文案改掉',
    ts: '100.001',
    threadTs: undefined,
    isBot: false,
    ...overrides,
  }
}

export const FULL_REPORT = [
  '干完了。',
  '## 交卷',
  '- 仓库：demo',
  '- 分支：feat/button-copy',
  '- Commit：1234567890abcdef1234567890abcdef12345678',
  '- PR：https://cnb.cool/x/demo/pulls/7',
  '- 测试：npm test，12 通过 0 失败',
  '- AC 对照：AC-1 达成；AC-2 达成',
].join('\n')
