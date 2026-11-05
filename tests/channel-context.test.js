import assert from 'node:assert/strict'
import test from 'node:test'
import { ChannelContextService, formatChannelContext } from '../lib/channel-context.js'

function fakeTransport({ info, messages, failInfo = false, failMessages = false } = {}) {
  return {
    infoCalls: 0,
    messageCalls: 0,
    info,
    messages,
    async fetchChannelInfo() {
      this.infoCalls++
      if (failInfo) throw new Error('缺权限')
      return this.info
    },
    async fetchChannelMessages() {
      this.messageCalls++
      if (failMessages) throw new Error('缺权限')
      return this.messages
    },
  }
}

test('AC-15 formatChannelContext：主题/说明/消息齐全成块，空文本消息过滤', () => {
  const block = formatChannelContext({
    channelId: 'C1',
    info: { name: 'cbec-software', topic: '仓库 cnb.cool/x/cbec', purpose: '跨境电商' },
    messages: [
      { user: 'U1', text: '先跑测试', ts: '1.1' },
      { user: 'U2', text: '  ', ts: '1.2' },
      { user: 'U2', text: '多行\n消息  压一行', ts: '1.3' },
    ],
  })
  assert.match(block, /#cbec-software/)
  assert.match(block, /仓库 cnb\.cool\/x\/cbec/)
  assert.match(block, /\[U1\] 先跑测试/)
  assert.match(block, /\[U2\] 多行 消息 压一行/)
  assert.doesNotMatch(block, /\n- \[U2\] \n/)
})

test('AC-15 未设主题/说明与无消息时给占位，不报错', () => {
  const block = formatChannelContext({ channelId: 'C9', info: null, messages: [] })
  assert.match(block, /C9/)
  assert.match(block, /（未设置）/)
  assert.match(block, /（无）/)
})

test('AC-15 服务缓存：同主题不重读；主题变或过期重读；超长截断', async () => {
  let now = 1000
  const transport = fakeTransport({
    info: { name: 'general', topic: '主题A', purpose: '' },
    messages: [{ user: 'U1', text: 'hi', ts: '1' }],
  })
  const svc = new ChannelContextService({ transport, refreshMs: 100, now: () => now })
  await svc.getContext('C1')
  await svc.getContext('C1')
  assert.equal(transport.messageCalls, 1)
  transport.info = { name: 'general', topic: '主题B', purpose: '' }
  const block = await svc.getContext('C1')
  assert.equal(transport.messageCalls, 2)
  assert.match(block, /主题B/)
  now += 1000 // 过期
  await svc.getContext('C1')
  assert.equal(transport.messageCalls, 3)

  const long = new ChannelContextService({
    transport: fakeTransport({
      info: { name: 'x', topic: 't', purpose: '' },
      messages: Array.from({ length: 50 }, (_, i) => ({ user: 'U', text: `消息${i} ` + 'x'.repeat(200), ts: String(i) })),
    }),
    maxChars: 500,
  })
  const truncated = await long.getContext('C2')
  assert.ok(truncated.length < 600)
  assert.match(truncated, /截断/)
})

test('AC-15 容错：读频道失败也返回最小上下文块，不抛错', async () => {
  const svc = new ChannelContextService({ transport: fakeTransport({ failInfo: true, failMessages: true }) })
  const block = await svc.getContext('C7')
  assert.match(block, /频道上下文/)
  assert.match(block, /C7/)
})
