import assert from 'node:assert/strict'
import test from 'node:test'
import { readTokens, validateConfig } from '../lib/config.js'
import { TaskQueue } from '../lib/queue.js'
import { createRedactor, truncate } from '../lib/redact.js'
import { buildDispatchPrompt, validateReport } from '../lib/render.js'
import { FULL_REPORT } from './helpers.js'

test('TaskQueue：单活、排队位次、上限拒单、取消排队', () => {
  const q = new TaskQueue(2)
  const t1 = { id: 1 }
  const t2 = { id: 2 }
  const t3 = { id: 3 }
  const t4 = { id: 4 }
  assert.equal(q.enqueue(t1).position, 0)
  assert.equal(q.enqueue(t2).position, 1)
  assert.equal(q.enqueue(t3).position, 2)
  assert.equal(q.enqueue(t4).position, -1)
  assert.equal(q.removeWaiting(t => t === t2), true)
  assert.equal(q.finishActive(), t3)
  assert.equal(q.active, t3)
  assert.equal(q.finishActive(), undefined)
})

test('AC-04 validateReport：齐全通过、缺字段与坏 commit 被抓', () => {
  const ok = validateReport(FULL_REPORT)
  assert.equal(ok.ok, true)
  assert.equal(ok.fields.repo, 'demo')
  const missing = validateReport('## 交卷\n- 仓库：demo\n- 分支：x')
  assert.equal(missing.ok, false)
  assert.ok(missing.missing.includes('pr'))
  assert.ok(missing.missing.includes('tests'))
  const badCommit = validateReport(FULL_REPORT.replace('1234567890abcdef1234567890abcdef12345678', '不是hash'))
  assert.equal(badCommit.ok, false)
  assert.ok(badCommit.missing.includes('commit-format'))
  const none = validateReport('我干完了')
  assert.equal(none.ok, false)
})

test('buildDispatchPrompt：带交卷合同与纪律', () => {
  const p = buildDispatchPrompt({ repo: 'demo', issueUrl: 'https://x/issues/1', body: '改文案' })
  assert.match(p, /## 交卷/)
  assert.match(p, /未 push 到远程分支不算完成/)
  assert.match(p, /改文案/)
})

test('AC-10 redact：抹 token 模式与登记秘密，truncate 保留头尾', () => {
  const redact = createRedactor(['super-secret-value'])
  const out = redact('token xoxb-123-abc 与 xapp-999 还有 super-secret-value')
  assert.doesNotMatch(out, /xoxb-123/)
  assert.doesNotMatch(out, /xapp-999/)
  assert.doesNotMatch(out, /super-secret-value/)
  const long = truncate('a'.repeat(5000), 100)
  assert.ok(long.length < 300)
  assert.match(long, /省略/)
})

test('config：必填校验、默认值、token 从 env 读', () => {
  assert.throws(() => validateConfig({}), /缺少必填配置/)
  assert.throws(() => validateConfig({ channelId: 'C', allowedUserIds: ['U'], repoRoots: { a: 'relative/path' } }), /不是绝对路径/)
  const c = validateConfig({ channelId: 'C', allowedUserIds: ['U'], repoRoots: { a: 'D:/repos/a' } })
  assert.equal(c.approvalTimeoutMinutes, 30)
  assert.equal(c.queueLimit, 5)
  const tokens = readTokens(c, { DSH_SLACK_APP_TOKEN: 'xapp-1', DSH_SLACK_BOT_TOKEN: 'xoxb-1' })
  assert.equal(tokens.appToken, 'xapp-1')
  assert.throws(() => readTokens(c, {}), /未设置/)
})
