import assert from 'node:assert/strict'
import test from 'node:test'
import { ApprovalManager } from '../lib/approvals.js'

test('审批：thread 回复作答（准）', async () => {
  const m = new ApprovalManager({ timeoutMs: 1000 })
  const p = m.request({ threadKey: 't1', summary: 'git push', post: async () => 'msg-1' })
  assert.equal(m.hasPendingForThread('t1'), true)
  assert.equal(m.resolveByThread('t1', true), true)
  assert.equal(await p, true)
  assert.equal(m.hasPendingForThread('t1'), false)
})

test('审批：表情按消息 ts 作答（驳），超时按驳回', async () => {
  const m = new ApprovalManager({ timeoutMs: 40 })
  const p1 = m.request({ threadKey: 't2', summary: 'x', post: async () => 'msg-9' })
  await new Promise(r => setTimeout(r, 0)) // 等 post 回填 messageTs（真实场景里人答得更晚，不影响语义）
  assert.equal(m.resolveByMessage('msg-9', false), true)
  assert.equal(await p1, false)
  const p2 = m.request({ threadKey: 't3', summary: 'y' })
  assert.equal(await p2, false)
})
