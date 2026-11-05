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

test('AC-02 接单：白名单用户派单 -> 打勾、开工帖、按仓根建 session、prompt 带 issue', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent())
  assert.ok(transport.reactionsAdded.some(r => r.timestamp === '100.001' && r.name === 'white_check_mark'))
  const posts = transport.postsInThread('100.001')
  assert.ok(posts.some(p => /已开工/.test(p.text)))
  assert.equal(ctx.createdAgents.length, 1)
  assert.equal(ctx.createdAgents[0].cwd, 'D:/repos/demo')
  assert.match(ctx.createdAgents[0].agent.followups[0], /issues\/1/)
})

test('AC-02 反面：非白名单用户与普通消息无反应', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent({ user: 'U9' }))
  await transport.emitMessage(dispatchEvent({ ts: '100.002', text: '今天吃什么' }))
  assert.equal(ctx.createdAgents.length, 0)
  assert.equal(transport.posts.length, 0)
  assert.equal(transport.reactionsAdded.length, 0)
})

test('拒单：未知仓库回帖说明并打 x', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent({ text: '[派单] 仓库：nope 干点活' }))
  assert.equal(ctx.createdAgents.length, 0)
  assert.ok(transport.postsInThread('100.001').some(p => /拒单/.test(p.text)))
  assert.ok(transport.reactionsAdded.some(r => r.name === 'x'))
})

test('AC-04/07 交卷与排队：两单串行，第一单交卷后第二单自动开工；缺字段标不完整', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent())
  await transport.emitMessage(dispatchEvent({ ts: '100.002', text: '[派单] 仓库：demo 第二个活' }))
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

test('AC-03 追问进同一 session；AC-09 [取消] 中止并推进队列外状态', async () => {
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

test('AC-05 审批往返：git push 先问，准 -> 放行；再问，驳 -> deny', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent())
  const exec = {
    tool: { name: 'bash' },
    args: { command: 'git push origin feat/x' },
    sessionId: 'slack-100001',
  }
  const first = ctx.runPreExecute(exec)
  await new Promise(r => setTimeout(r, 10))
  assert.ok(transport.postsInThread('100.001').some(p => /审批请求/.test(p.text)))
  await transport.emitMessage(dispatchEvent({ ts: '100.020', threadTs: '100.001', text: '准' }))
  assert.equal((await first).kind, 'next')

  const second = ctx.runPreExecute(exec)
  await new Promise(r => setTimeout(r, 10))
  await transport.emitMessage(dispatchEvent({ ts: '100.021', threadTs: '100.001', text: '驳' }))
  assert.equal((await second).kind, 'deny')
})

test('AC-06 硬拒绝直接 deny 且不惊动审批；外来 session 不归插件管', async () => {
  const { transport, ctx } = await setup()
  await transport.emitMessage(dispatchEvent())
  const deny = await ctx.runPreExecute({
    tool: { name: 'read' },
    args: { path: 'C:/Users/x/.ssh/id_rsa' },
    sessionId: 'slack-100001',
  })
  assert.equal(deny.kind, 'deny')
  assert.ok(transport.postsInThread('100.001').some(p => /硬拒绝/.test(p.text)))
  const other = await ctx.runPreExecute({
    tool: { name: 'bash' },
    args: { command: 'git push origin x' },
    sessionId: 'someone-elses-session',
  })
  assert.equal(other.kind, 'next')
})

test('AC-08 补扫：离线期间的派单在启动后被接单，已打勾的跳过', async () => {
  const transport = new FakeTransport()
  transport.historyData = [
    { user: 'U1', text: '[派单] 仓库：demo 已经处理过的', ts: '99.002' },
    { user: 'U1', text: '[派单] 仓库：demo 离线时发的活', ts: '99.001' },
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
