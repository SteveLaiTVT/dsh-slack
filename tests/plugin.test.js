import assert from 'node:assert/strict'
import test from 'node:test'
import { createSlackPlugin } from '../lib/plugin.js'
import { dispatchEvent, FakeCtx, FakeTransport, FULL_REPORT, TEST_CONFIG } from './helpers.js'

async function setup(history = []) {
  const transport = new FakeTransport()
  transport.historyData = history
  const ctx = new FakeCtx()
  const plugin = createSlackPlugin({
    transport,
    tokens: { appToken: 'xapp-test', botToken: 'xoxb-test' },
    logger: { log: () => {} },
  })
  await plugin.apply(ctx, TEST_CONFIG)
  return { transport, ctx }
}

test('AC-02/14 接单：任意成员派单 -> 打勾、开工帖、session cwd=workdir、prompt 带 issue 与频道上下文', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent({ user: 'U9' }))
  assert.ok(transport.reactionsAdded.some(r => r.timestamp === '100.001' && r.name === 'white_check_mark'))
  const posts = transport.postsInThread('100.001')
  assert.ok(posts.some(p => /已开工/.test(p.text)))
  assert.equal(ctx.createdAgents.length, 1)
  assert.equal(ctx.createdAgents[0].cwd, 'D:/dsh-work')
  const prompt = ctx.createdAgents[0].agent.followups[0]
  assert.match(prompt, /issues\/1/)
  assert.match(prompt, /频道上下文/)
  assert.match(prompt, /example\.com\/x\/demo\.git/)
})

test('AC-14 任意频道：未配置过的频道、另一个成员同样接单（排队）', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent())
  await transport.emitMessage(dispatchEvent({ channel: 'C9', user: 'U7', ts: '100.002', text: '[派单] 另一个频道的活' }))
  assert.ok(transport.postsInThread('100.002').some(p => /排队第 1 位/.test(p.text)))
  assert.equal(ctx.createdAgents.length, 1)
})

test('AC-15 频道上下文缓存：同频道第二单不重读消息；主题变化后重读', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent())
  assert.equal(transport.messageCalls, 1)
  const s1 = 'slack-100001'
  await ctx.emitSessionEvent(s1, { type: 'assistant/message', data: { text: FULL_REPORT } })
  await ctx.emitSessionEvent(s1, { type: 'turn/end', data: {} })
  await new Promise(r => setTimeout(r, 0))
  await transport.emitMessage(dispatchEvent({ ts: '100.002', text: '[派单] 第二个活' }))
  assert.equal(transport.messageCalls, 1)
  // 主题变了 -> 下一单重读
  transport.channelInfo = { ...transport.channelInfo, topic: '新主题：换仓了' }
  const s2 = 'slack-100002'
  await ctx.emitSessionEvent(s2, { type: 'assistant/message', data: { text: FULL_REPORT } })
  await ctx.emitSessionEvent(s2, { type: 'turn/end', data: {} })
  await new Promise(r => setTimeout(r, 0))
  await transport.emitMessage(dispatchEvent({ ts: '100.003', text: '[派单] 第三个活' }))
  assert.equal(transport.messageCalls, 2)
  assert.match(ctx.createdAgents[2].agent.followups[0], /新主题/)
})

test('反面：bot 消息、普通聊天消息无反应', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent({ isBot: true }))
  await transport.emitMessage(dispatchEvent({ ts: '100.002', text: '今天吃什么' }))
  assert.equal(ctx.createdAgents.length, 0)
  assert.equal(transport.posts.length, 0)
  assert.equal(transport.reactionsAdded.length, 0)
})

test('AC-04/07 交卷与排队：两单串行，第一单交卷后第二单自动开工；缺字段标不完整', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent())
  await transport.emitMessage(dispatchEvent({ ts: '100.002', text: '[派单] 第二个活' }))
  assert.equal(ctx.createdAgents.length, 1)
  assert.ok(transport.postsInThread('100.002').some(p => /排队第 1 位/.test(p.text)))

  const s1 = 'slack-100001'
  await ctx.emitSessionEvent(s1, { type: 'assistant/message', data: { text: FULL_REPORT } })
  await ctx.emitSessionEvent(s1, { type: 'turn/end', data: {} })
  await new Promise(r => setTimeout(r, 0)) // 交卷->推进队列是异步链，等一个宏任务排空
  assert.ok(transport.postsInThread('100.001').some(p => /交卷（字段齐全）/.test(p.text)))
  assert.equal(ctx.createdAgents.length, 2)

  const s2 = 'slack-100002'
  await ctx.emitSessionEvent(s2, { type: 'assistant/message', data: { text: '搞定了' } })
  await ctx.emitSessionEvent(s2, { type: 'turn/end', data: {} })
  await new Promise(r => setTimeout(r, 0))
  assert.ok(transport.postsInThread('100.002').some(p => /交卷不完整/.test(p.text)))
})

test('AC-03 追问进同一 session；AC-09 [取消] 中止', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent())
  const agent = ctx.createdAgents[0].agent
  await transport.emitMessage(dispatchEvent({ ts: '100.010', threadTs: '100.001', text: '顺便把标题也改了' }))
  assert.equal(agent.followups.length, 2)
  assert.match(agent.followups[1], /标题/)
  await transport.emitMessage(dispatchEvent({ ts: '100.011', threadTs: '100.001', text: '[取消]' }))
  assert.equal(agent.cancelCalls.length, 1)
  assert.deepEqual(agent.cancelCalls[0], { kind: 'user' })
  assert.ok(transport.postsInThread('100.001').some(p => /已取消/.test(p.text)))
})

test('v0.4 不拦截工具执行：不注册 tools/pre-execute，thread 里发「准」按普通追问进 session', async () => {
  const { transport, ctx } = await setup()
  assert.equal(ctx.handlers.has('tools/pre-execute'), false)
  await transport.emitMessage(dispatchEvent())
  const agent = ctx.createdAgents[0].agent
  await transport.emitMessage(dispatchEvent({ ts: '100.020', threadTs: '100.001', text: '准' }))
  assert.equal(agent.followups.length, 2)
  assert.match(agent.followups[1], /准/)
  assert.equal(transport.postsInThread('100.001').some(p => /审批请求/.test(p.text)), false)
})

test('AC-08 补扫：遍历 bot 已加入频道，离线期间的派单被接单，已打勾的跳过', async () => {
  const transport = new FakeTransport()
  transport.historyData = [
    { user: 'U1', text: '[派单] 已经处理过的', ts: '99.002' },
    { user: 'U3', text: '[派单] 离线时发的活', ts: '99.001' },
  ]
  transport.reactionUsers.set('99.002:white_check_mark', ['UBOT'])
  const ctx = new FakeCtx()
  const plugin = createSlackPlugin({
    transport,
    tokens: { appToken: 'xapp-test', botToken: 'xoxb-test' },
    logger: { log: () => {} },
  })
  await plugin.apply(ctx, TEST_CONFIG)
  assert.equal(ctx.createdAgents.length, 1)
  assert.ok(transport.postsInThread('99.001').length >= 1)
  assert.equal(transport.postsInThread('99.002').length, 0)
})
