import assert from 'node:assert/strict'
import test from 'node:test'
import { createSlackPlugin } from '../lib/plugin.js'
import { createRedactor } from '../lib/redact.js'
import { buildReportCard, REPORT_CARD_LIMITS, validateReport } from '../lib/render.js'
import { SlackTransport } from '../lib/transport.js'
import { dispatchEvent, FakeCtx, FakeTransport, FULL_REPORT, TEST_CONFIG } from './helpers.js'

const HASH = '1234567890abcdef1234567890abcdef12345678'
const TOKENS = { appToken: 'xapp-test', botToken: 'xoxb-test' }
const REDACT = createRedactor([TOKENS.appToken, TOKENS.botToken])
const INTERACTIVE_TYPES = new Set([
  'actions', 'button', 'static_select', 'multi_static_select', 'overflow', 'datepicker',
  'timepicker', 'radio_buttons', 'checkboxes', 'plain_text_input', 'users_select',
  'multi_users_select', 'conversations_select', 'multi_conversations_select',
  'channels_select', 'multi_channels_select', 'external_select', 'multi_external_select',
  'workflow_button', 'rich_text_input',
])
const REPORT_TEXT_RE = /交卷（字段齐全）|交卷不完整|交卷卡片构造失败/

function reportText(fields = {}) {
  const value = {
    repo: 'demo',
    branch: 'feat/button-copy',
    commit: HASH,
    pr: 'https://cnb.cool/x/demo/pulls/7',
    tests: 'npm test，12 通过 0 失败',
    ac: 'AC-1 达成；AC-2 达成',
    ...fields,
  }
  return [
    '干完了。MARKER-原文',
    '## 交卷',
    `- 仓库：${value.repo}`,
    `- 分支：${value.branch}`,
    `- Commit：${value.commit}`,
    `- PR：${value.pr}`,
    `- 测试：${value.tests}`,
    `- AC 对照：${value.ac}`,
  ].join('\n')
}

function cardOf(text, redact = REDACT) {
  return buildReportCard({ report: validateReport(text), originalText: text, redact })
}

function sectionBody(payload, label) {
  const prefix = `*${label}*\n`
  const block = payload.blocks.find(item => item.type === 'section' && item.text?.text?.startsWith(prefix))
  assert.ok(block, `缺少字段段 ${label}`)
  return block.text.text.slice(prefix.length)
}

function assertNoInteractive(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInteractive(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, 'action_id', `${path} 出现 action_id`)
    if (key === 'type' && INTERACTIVE_TYPES.has(child)) {
      assert.fail(`${path} 出现交互元素 ${child}`)
    }
    assertNoInteractive(child, `${path}.${key}`)
  }
}

function assertEntitiesIntact(text) {
  const stripped = text.replace(/<https?:\/\/[^|\s<>]+\|打开 PR>/g, '')
  assert.equal(/[<>]/.test(stripped), false, text)
  assert.equal(/&(?!amp;|lt;|gt;)/.test(stripped), false, text)
}

function assertWithinLimits(payload) {
  assert.ok(payload.text.length <= REPORT_CARD_LIMITS.text)
  for (const block of payload.blocks) {
    assert.ok(['header', 'section', 'divider', 'context'].includes(block.type), block.type)
    if (block.type === 'header') {
      assert.equal(block.text.type, 'plain_text')
      assert.ok(block.text.text.length <= REPORT_CARD_LIMITS.header)
    }
    if (block.type === 'section') {
      assert.equal(block.text.type, 'mrkdwn')
      assert.ok(block.text.text.length <= REPORT_CARD_LIMITS.section)
      assertEntitiesIntact(block.text.text)
    }
  }
  assertEntitiesIntact(payload.text)
  assertNoInteractive(payload)
}

async function flush() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

async function emit(transport, event) {
  if (typeof transport.emitMessage === 'function') {
    await transport.emitMessage(event)
    return
  }
  for (const handler of transport.messageHandlers) await handler(event)
}

function timeoutError() {
  const error = new Error('connect ETIMEDOUT')
  error.code = 'ETIMEDOUT'
  return error
}

async function runScenario({ kind, finalText = FULL_REPORT, onBlocks, onPlainReport, buildReportCard: cardBuilder }) {
  const calls = []
  const logs = []
  const decide = (args) => {
    if (!REPORT_TEXT_RE.test(args.text ?? '')) return { ok: true, ts: 'ops' }
    if (args.blocks != null) return onBlocks ? onBlocks() : { ok: true, ts: 'card' }
    return onPlainReport ? onPlainReport() : { ok: true, ts: 'plain' }
  }
  let transport
  if (kind === 'fake') {
    transport = new FakeTransport()
    const original = transport.postMessage.bind(transport)
    transport.postMessage = async (channel, text, threadTs, blocks) => {
      calls.push({ channel, text, threadTs, blocks })
      const outcome = decide({ text, blocks })
      if (outcome instanceof Error) throw outcome
      if (outcome && outcome.ok === false) {
        const error = new Error(outcome.error)
        error.data = outcome
        throw error
      }
      return original(channel, text, threadTs, blocks)
    }
  } else {
    const webClient = {
      chat: {
        postMessage: async (args) => {
          calls.push({
            channel: args.channel,
            text: args.text,
            threadTs: args.thread_ts,
            blocks: args.blocks,
            unfurl_links: args.unfurl_links,
            unfurl_media: args.unfurl_media,
          })
          const outcome = decide(args)
          if (outcome instanceof Error) throw outcome
          return outcome
        },
      },
    }
    transport = new SlackTransport({ ...TOKENS, webClient })
    transport.connect = async () => transport
  }
  const ctx = new FakeCtx()
  const plugin = createSlackPlugin({
    transport,
    tokens: TOKENS,
    logger: { log: (line) => logs.push(line) },
    ...(cardBuilder ? { buildReportCard: cardBuilder } : {}),
  })
  await plugin.apply(ctx, TEST_CONFIG)
  await emit(transport, dispatchEvent())
  await emit(transport, dispatchEvent({ ts: '100.002', text: '[派单] 第二个活' }))
  await emit(transport, dispatchEvent({ ts: '100.003', text: '[派单] 第三个活' }))
  await ctx.emitSessionEvent('slack-100001', { type: 'assistant/message', data: { text: finalText } })
  await ctx.emitSessionEvent('slack-100001', { type: 'turn/end', data: {} })
  await flush()
  return {
    calls,
    reportCalls: calls.filter(call => REPORT_TEXT_RE.test(call.text ?? '')),
    logs,
    ctx,
    started: calls.filter(call => /已开工/.test(call.text ?? '')).map(call => call.threadTs),
  }
}

function assertQueueOnce(result, kind) {
  assert.deepEqual(result.started, ['100.001', '100.002'], kind)
  assert.equal(result.ctx.createdAgents.length, 2, kind)
  assert.equal(result.logs.filter(line => line.includes('交卷送达状态：')).length, 1, kind)
  assert.doesNotMatch(result.logs.join('\n'), /完整交卷/, kind)
}

function assertDelivery(result, label, kind) {
  assert.match(result.logs.join('\n'), new RegExp(`交卷送达状态：${label}`), kind)
}

test('AC-22 validateReport：多行、空值、歧义、commit/PR 反例', () => {
  const multiline = reportText({
    ac: 'AC-1 达成\nAC-2 失败：按钮颜色不对\nAC-3 达成',
  })
  const acReport = validateReport(multiline)
  assert.equal(acReport.ok, true)
  assert.equal(acReport.fields.ac, 'AC-1 达成\nAC-2 失败：按钮颜色不对\nAC-3 达成')

  const testsNextLine = [
    '## 交卷',
    '- 仓库：demo',
    '- 分支：feat/x',
    `- Commit：${HASH}`,
    '- PR：https://example.com/pr/1',
    '- 测试：',
    'npm test，12 通过 0 失败',
    '- AC 对照：AC-1 达成',
  ].join('\n')
  const testsReport = validateReport(testsNextLine)
  assert.equal(testsReport.ok, true)
  assert.equal(testsReport.fields.tests, 'npm test，12 通过 0 失败')

  const emptyPr = [
    '## 交卷',
    '- 仓库：demo',
    '- 分支：feat/x',
    `- Commit：${HASH}`,
    '- PR：',
    '- 测试：npm test，1 通过',
    '- AC 对照：AC-1 达成',
  ].join('\n')
  const emptyPrReport = validateReport(emptyPr)
  assert.equal(emptyPrReport.ok, false)
  assert.equal(emptyPrReport.fields.pr, undefined)
  assert.ok(emptyPrReport.missing.includes('pr'))
  assert.equal(emptyPrReport.missing.includes('pr-format'), false)
  assert.equal(emptyPrReport.fields.tests, 'npm test，1 通过')

  const dup = validateReport(reportText({ repo: 'demo' }).replace('- 仓库：demo', '- 仓库：demo\n- 仓库：other'))
  assert.equal(dup.ok, false)
  assert.equal(dup.ambiguous, true)
  assert.deepEqual(dup.ambiguousFields, ['repo'])
  assert.equal(dup.fields.repo, undefined)

  const same = validateReport(reportText().replace('- 仓库：demo', '- 仓库：demo\n- 仓库：demo'))
  assert.equal(same.ok, true)
  assert.equal(same.fields.repo, 'demo')

  const twoBlocks = validateReport(`${reportText()}\n## 交卷\n- 仓库：second`)
  assert.equal(twoBlocks.ok, false)
  assert.equal(twoBlocks.ambiguity, 'duplicate-block')
  assert.equal(twoBlocks.fields.repo, undefined)

  for (const commit of [`${HASH} 附注`, 'abc1234', `${HASH}aa`, `见提交 ${HASH}`]) {
    const bad = validateReport(reportText({ commit }))
    assert.equal(bad.ok, false, commit)
    assert.ok(bad.missing.includes('commit-format'), commit)
    assert.equal(bad.fields.commit, commit.trim())
  }
  assert.equal(validateReport(reportText({ commit: HASH.toUpperCase() })).ok, true)

  for (const pr of ['稍后补', '无', '无。', '无：', 'https://example.com/a b', 'https://example.com/a>b', 'https://example.com/a|b', 'ftp://example.com/pr/1']) {
    const bad = validateReport(reportText({ pr }))
    assert.equal(bad.ok, false, pr)
    assert.ok(bad.missing.includes('pr-format'), pr)
    assert.equal(bad.missing.includes('pr'), false, pr)
  }
  for (const pr of ['无：还没 push', '无，未建 PR', '无（任务不要求）', 'https://example.com/pr?a=1&b=2']) {
    const good = validateReport(reportText({ pr }))
    assert.equal(good.ok, true, pr)
    assert.equal(good.fields.pr, pr)
    assert.equal(good.prKind, pr.startsWith('无') ? 'wu' : 'url')
  }

  const english = [
    '## 交卷',
    '- repo: demo',
    '- branch: feat/x',
    `- commit: ${HASH}`,
    '- PR: https://example.com/pr/9',
    '- tests: npm test',
    '- AC: AC-1 达成',
  ].join('\n')
  const englishReport = validateReport(english)
  assert.equal(englishReport.ok, true)
  assert.equal(englishReport.fields.repo, 'demo')
  assert.equal(englishReport.fields.ac, 'AC-1 达成')

  const none = validateReport('我干完了')
  assert.equal(none.ok, false)
  assert.deepEqual(none.missing, ['repo', 'branch', 'commit', 'pr', 'tests', 'ac'])
})

test('AC-23 buildReportCard：脱敏先于转义、链接不截断、超长显式截断、长度终检', () => {
  const redact = createRedactor(['sec&ret-value'])
  const text = reportText({
    repo: 'pre sec&ret-value post & <!channel> <@U123>',
    pr: 'https://example.com/pr?a=1&b=2',
    ac: 'AC-1 达成\nAC-2 失败：按钮颜色不对',
  })
  const payload = cardOf(text, redact)
  const blob = JSON.stringify(payload)
  assert.equal(blob.includes('sec&ret-value'), false)
  assert.equal(blob.includes('sec&amp;ret-value'), false)
  assert.match(blob, /\[REDACTED\]/)
  assert.match(blob, /&amp;/)
  assert.match(blob, /&lt;!channel&gt;/)
  assert.match(blob, /&lt;@U123&gt;/)
  assert.doesNotMatch(blob, /<!channel>/)
  assert.doesNotMatch(blob, /<@U/)
  assert.doesNotMatch(blob, /&amp;amp;/)
  assert.match(blob, /<https:\/\/example\.com\/pr\?a=1&b=2\|打开 PR>/)
  assert.doesNotMatch(sectionBody(payload, 'PR'), /&amp;/)
  assert.match(sectionBody(payload, 'AC 对照'), /AC-2 失败：按钮颜色不对/)
  assert.equal(payload.text.includes('干完了'), false)
  assert.equal(JSON.stringify(payload.blocks).includes('原文'), false)
  assertWithinLimits(payload)
  for (const key of ['仓库', '分支', 'Commit', 'PR', '测试', 'AC 对照']) {
    assert.match(payload.text, new RegExp(`${key}：`))
  }

  const longAc = cardOf(reportText({ ac: '测'.repeat(4000) }))
  const acBody = sectionBody(longAc, 'AC 对照')
  assert.match(acBody, /…（已截断）$/)
  assert.ok(acBody.length < 4000)
  assert.match(longAc.text, /AC 对照：.*…（已截断）/)
  assert.equal(longAc.text.includes('省略'), false)
  assertWithinLimits(longAc)
  assert.equal(longAc.blocks[0].text.text, '交卷（字段齐全）')

  const amps = cardOf(reportText({ repo: '&'.repeat(4000) }))
  const repoBody = sectionBody(amps, '仓库')
  assert.match(repoBody, /^(?:&amp;)+…（已截断）$/)
  assertWithinLimits(amps)

  const longUrl = `https://example.com/${'a'.repeat(4000)}`
  const longPr = cardOf(reportText({ pr: longUrl }))
  const prBody = sectionBody(longPr, 'PR')
  assert.match(prBody, /…（已截断）/)
  assert.doesNotMatch(prBody, /\|打开 PR>/)
  assert.doesNotMatch(longPr.text, /\|打开 PR>/)
  assertWithinLimits(longPr)

  const broken = cardOf(reportText({ pr: 'https://example.com/a>b' }))
  assert.match(sectionBody(broken, 'PR'), /a&gt;b/)
  assert.doesNotMatch(JSON.stringify(broken), /\|打开 PR>/)
  assert.match(broken.text, /交卷不完整/)
  assert.match(broken.text, /PR（pr-format）/)
  assertWithinLimits(broken)

  const leaked = `xoxb-leak-token MARKER-原文\n${reportText({ pr: '' })}`
  const incomplete = cardOf(leaked)
  const original = sectionBody(incomplete, '原文')
  assert.match(original, /MARKER-原文/)
  assert.equal(original.includes('xoxb-leak-token'), false)
  assert.match(original, /\[REDACTED\]/)
  assert.equal(sectionBody(incomplete, 'PR'), '—')
  assert.match(incomplete.text, /字段缺失/)
  assertWithinLimits(incomplete)
})

test('AC-17 齐全卡：FakeTransport 收到 text+blocks，PR 可点，标题只写字段齐全', async () => {
  const result = await runScenario({ kind: 'fake', finalText: FULL_REPORT })
  assertQueueOnce(result, 'fake')
  assertDelivery(result, '已送达', 'fake')
  assert.equal(result.reportCalls.length, 1)
  const call = result.reportCalls[0]
  assert.ok(Array.isArray(call.blocks))
  assert.equal(call.blocks[0].text.text, '交卷（字段齐全）')
  assert.match(call.text, /交卷（字段齐全）/)
  assert.doesNotMatch(call.text, /测试通过|可合并/)
  assert.equal(call.text.includes('干完了'), false)
  const blob = JSON.stringify(call.blocks)
  assert.match(blob, /demo/)
  assert.match(blob, /feat\/button-copy/)
  assert.match(blob, new RegExp(HASH))
  assert.match(blob, /npm test，12 通过 0 失败/)
  assert.match(blob, /AC-1 达成/)
  assert.match(blob, /<https:\/\/cnb\.cool\/x\/demo\/pulls\/7\|打开 PR>/)
  assert.equal(blob.includes('原文'), false)
  assertNoInteractive(call)

  const reason = reportText({ pr: '无：还没 push' })
  const wu = await runScenario({ kind: 'fake', finalText: reason })
  const wuCall = wu.reportCalls[0]
  assert.match(wuCall.text, /交卷（字段齐全）/)
  assert.match(sectionBody({ blocks: wuCall.blocks }, 'PR'), /无：还没 push/)
  assert.doesNotMatch(JSON.stringify(wuCall.blocks), /\|打开 PR>/)
  assertQueueOnce(wu, 'wu')
})

test('AC-18 不完整卡：缺项、原因码、缺槽、脱敏原文，队列仍推进一次', async () => {
  const cases = [
    {
      name: 'missing',
      text: `MARKER-原文 xoxb-leak-token\n${reportText({ pr: '' })}`,
      reasons: ['PR（字段缺失）'],
      dashes: ['PR'],
      shows: ['demo'],
    },
    {
      name: 'commit-format',
      text: reportText({ commit: 'abc1234' }),
      reasons: ['Commit（commit-format）'],
      dashes: [],
      shows: ['abc1234'],
    },
    {
      name: 'pr-format',
      text: reportText({ pr: '稍后补' }),
      reasons: ['PR（pr-format）'],
      dashes: [],
      shows: ['稍后补'],
    },
    {
      name: 'ambiguous-field',
      text: reportText().replace('- 仓库：demo', '- 仓库：demo\n- 仓库：other'),
      reasons: ['仓库（解析歧义）'],
      dashes: ['仓库'],
      shows: ['feat/button-copy'],
    },
    {
      name: 'two-blocks',
      text: `${reportText()}\n## 交卷\n- 仓库：second`,
      reasons: ['解析歧义'],
      dashes: ['仓库', '分支', 'Commit', 'PR', '测试', 'AC 对照'],
      shows: [],
    },
  ]
  for (const item of cases) {
    const result = await runScenario({ kind: 'fake', finalText: item.text })
    assertQueueOnce(result, item.name)
    assertDelivery(result, '已送达', item.name)
    assert.equal(result.reportCalls.length, 1, item.name)
    const call = result.reportCalls[0]
    assert.equal(call.blocks[0].text.text, '交卷不完整', item.name)
    assert.match(call.text, /交卷不完整/, item.name)
    for (const reason of item.reasons) {
      assert.match(call.text, new RegExp(reason.replace(/[()]/g, '\\$&')), item.name)
      assert.match(JSON.stringify(call.blocks), new RegExp(reason.replace(/[()]/g, '\\$&')), item.name)
    }
    for (const label of item.dashes) assert.equal(sectionBody({ blocks: call.blocks }, label), '—', item.name)
    for (const snippet of item.shows) assert.match(JSON.stringify(call.blocks), new RegExp(snippet), item.name)
    assert.match(sectionBody({ blocks: call.blocks }, '原文'), /MARKER-原文/, item.name)
    if (item.name === 'missing') {
      assert.equal(JSON.stringify(call).includes('xoxb-leak-token'), false)
      assert.match(JSON.stringify(call), /\[REDACTED\]/)
    }
    assertNoInteractive(call)
  }
})

test('SlackTransport.postMessage：blocks 缺省不改现网入参，ok:false 归一成 data.error', async () => {
  const calls = []
  const transport = new SlackTransport({
    ...TOKENS,
    webClient: {
      chat: {
        postMessage: async (args) => {
          calls.push(args)
          if (args.text === 'reject') return { ok: false, error: 'invalid_blocks' }
          return { ok: true, ts: '1.2' }
        },
      },
    },
  })
  assert.equal(await transport.postMessage('C1', 'hello'), '1.2')
  assert.deepEqual(calls[0], { channel: 'C1', text: 'hello' })
  assert.equal(await transport.postMessage('C1', 'hello', 't1'), '1.2')
  assert.deepEqual(calls[1], { channel: 'C1', text: 'hello', thread_ts: 't1' })
  const blocks = [{ type: 'divider' }]
  await transport.postMessage('C1', 'card', 't1', blocks)
  assert.deepEqual(calls[2], {
    channel: 'C1',
    text: 'card',
    thread_ts: 't1',
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  })
  await assert.rejects(
    () => transport.postMessage('C1', 'reject', 't1', blocks),
    (error) => error.data?.error === 'invalid_blocks',
  )
})

test('AC-19 出站验收：stub 入参与 buildReportCard 逐字一致，无二次截断、无重复转义', async () => {
  const finalText = reportText({
    repo: 'demo & <!channel> <@U123> xoxb-aaa-bbbb',
    ac: `${'测'.repeat(4000)}\nAC-2 失败：按钮颜色不对`,
  })
  const expected = cardOf(finalText)
  assert.ok(expected.text.length > 2800)
  for (const kind of ['fake', 'slack']) {
    const result = await runScenario({ kind, finalText })
    assert.equal(result.reportCalls.length, 1, kind)
    const call = result.reportCalls[0]
    assert.equal(call.channel, 'C1', kind)
    assert.equal(call.threadTs, '100.001', kind)
    assert.equal(call.text, expected.text, kind)
    assert.deepEqual(call.blocks, expected.blocks, kind)
    assert.equal(call.text.includes('省略'), false, kind)
    assert.equal(call.text.includes('&amp;amp;'), false, kind)
    assert.equal(JSON.stringify(call).includes('xoxb-aaa-bbbb'), false, kind)
    assert.match(call.text, /&lt;!channel&gt;/, kind)
    if (kind === 'slack') {
      assert.equal(call.unfurl_links, false, kind)
      assert.equal(call.unfurl_media, false, kind)
    }
    assertQueueOnce(result, kind)
    assertDelivery(result, '已送达', kind)
  }
})

test('AC-19(a) 降级成功：名单内错误后同一纯文本重发成功，队列推进一次', async () => {
  const finalText = reportText({ ac: '测'.repeat(4000) })
  const expected = cardOf(finalText)
  for (const kind of ['fake', 'slack']) {
    const result = await runScenario({
      kind,
      finalText,
      onBlocks: () => ({ ok: false, error: 'invalid_blocks' }),
      onPlainReport: () => ({ ok: true, ts: 'plain-ok' }),
    })
    assert.equal(result.reportCalls.length, 2, kind)
    assert.ok(result.reportCalls[0].blocks, kind)
    assert.equal(result.reportCalls[1].blocks, undefined, kind)
    assert.equal(result.reportCalls[0].text, expected.text, kind)
    assert.equal(result.reportCalls[1].text, expected.text, kind)
    assert.equal(result.reportCalls[0].threadTs, '100.001', kind)
    assert.equal(result.reportCalls[1].threadTs, '100.001', kind)
    if (kind === 'slack') {
      assert.equal(result.reportCalls[0].unfurl_links, false, kind)
      assert.equal(result.reportCalls[1].unfurl_links, undefined, kind)
    }
    assertQueueOnce(result, kind)
    assertDelivery(result, '已送达', kind)
  }
})

test('AC-19(b) 明确拒绝：降级纯文本被错误码拒绝后不再重发，记未送达', async () => {
  for (const kind of ['fake', 'slack']) {
    const result = await runScenario({
      kind,
      onBlocks: () => ({ ok: false, error: 'invalid_blocks_format' }),
      onPlainReport: () => ({ ok: false, error: 'channel_not_found' }),
    })
    assert.equal(result.reportCalls.length, 2, kind)
    assert.equal(result.reportCalls[0].text, result.reportCalls[1].text, kind)
    assert.equal(result.reportCalls[1].blocks, undefined, kind)
    assertQueueOnce(result, kind)
    assertDelivery(result, '未送达', kind)
    assert.doesNotMatch(result.logs.join('\n'), /交卷送达状态：已送达/, kind)
  }
})

test('AC-19(c) 超时不确定：首发或降级超时都不盲目重发', async () => {
  for (const kind of ['fake', 'slack']) {
    const first = await runScenario({
      kind,
      onBlocks: () => timeoutError(),
      onPlainReport: () => { throw new Error('不应降级重发') },
    })
    assert.equal(first.reportCalls.length, 1, kind)
    assert.ok(first.reportCalls[0].blocks, kind)
    assertQueueOnce(first, kind)
    assertDelivery(first, '送达不确定', kind)

    const second = await runScenario({
      kind,
      onBlocks: () => ({ ok: false, error: 'invalid_blocks' }),
      onPlainReport: () => timeoutError(),
    })
    assert.equal(second.reportCalls.length, 2, kind)
    assertQueueOnce(second, kind)
    assertDelivery(second, '送达不确定', kind)
  }
})

test('AC-19(d) 首次非 blocks 错误：不降级；明确拒绝记未送达，internal/fatal 记不确定', async () => {
  const cases = [
    { error: 'msg_too_long', label: '未送达' },
    { error: 'invalid_attachments', label: '未送达' },
    { error: 'internal_error', label: '送达不确定' },
    { error: 'fatal_error', label: '送达不确定' },
  ]
  for (const kind of ['fake', 'slack']) {
    for (const item of cases) {
      const result = await runScenario({
        kind,
        onBlocks: () => ({ ok: false, error: item.error }),
        onPlainReport: () => { throw new Error(`不应降级 ${item.error}`) },
      })
      assert.equal(result.reportCalls.length, 1, `${kind} ${item.error}`)
      assert.ok(result.reportCalls[0].blocks, `${kind} ${item.error}`)
      assertQueueOnce(result, `${kind} ${item.error}`)
      assertDelivery(result, item.label, `${kind} ${item.error}`)
    }
  }
})

test('AC-19(e) 构造失败：独立纯文本兜底，不依赖失败构造函数，三态各记一次', async () => {
  const finalText = `xoxb-secret-token-value\n${FULL_REPORT}`
  const outcomes = [
    { name: 'delivered', onPlainReport: () => ({ ok: true, ts: 'fb' }), label: '已送达' },
    { name: 'rejected', onPlainReport: () => ({ ok: false, error: 'channel_not_found' }), label: '未送达' },
    { name: 'timeout', onPlainReport: () => timeoutError(), label: '送达不确定' },
  ]
  for (const kind of ['fake', 'slack']) {
    for (const item of outcomes) {
      let builds = 0
      const result = await runScenario({
        kind,
        finalText,
        buildReportCard: () => {
          builds += 1
          throw new Error('构造炸了')
        },
        onBlocks: () => { throw new Error('构造失败不应发卡片') },
        onPlainReport: item.onPlainReport,
      })
      assert.equal(builds, 1, `${kind} ${item.name}`)
      assert.equal(result.reportCalls.length, 1, `${kind} ${item.name}`)
      const call = result.reportCalls[0]
      assert.equal(call.blocks, undefined, `${kind} ${item.name}`)
      assert.match(call.text, /交卷卡片构造失败，纯文本兜底/, `${kind} ${item.name}`)
      assert.doesNotMatch(call.text, /字段齐全|完整交卷|\|打开 PR>/, `${kind} ${item.name}`)
      assert.equal(call.text.includes('xoxb-secret-token-value'), false, `${kind} ${item.name}`)
      assert.match(call.text, /\[REDACTED\]/, `${kind} ${item.name}`)
      assertQueueOnce(result, `${kind} ${item.name}`)
      assertDelivery(result, item.label, `${kind} ${item.name}`)
    }
  }
})

test('AC-20 开工/排队/取消/启动失败仍是纯文本，文案不变', async () => {
  const transport = new FakeTransport()
  const ctx = new FakeCtx()
  const plugin = createSlackPlugin({
    transport,
    tokens: TOKENS,
    logger: { log: () => {} },
  })
  await plugin.apply(ctx, TEST_CONFIG)
  await transport.emitMessage(dispatchEvent())
  await transport.emitMessage(dispatchEvent({ ts: '100.002', text: '[派单] 第二个活' }))
  const started = transport.postsInThread('100.001').find(post => post.text.includes('已开工'))
  assert.equal(started.text, '▶️ 已开工：session slack-100001。本频道的主题/说明/近期消息已作为上下文交给执行方，由它定仓开工。进度与结果回本 thread；发「[取消]」可中止。')
  assert.equal(started.blocks, undefined)
  const queued = transport.postsInThread('100.002').find(post => post.text.includes('排队'))
  assert.equal(queued.text, '📥 已接单。当前有任务在执行，本单排队第 1 位。')
  assert.equal(queued.blocks, undefined)
  await transport.emitMessage(dispatchEvent({ ts: '100.030', threadTs: '100.001', text: '[取消]' }))
  const activeCancel = transport.postsInThread('100.001').find(post => post.text.includes('已取消'))
  assert.equal(activeCancel.text, '🛑 已取消正在执行的任务。来源：thread 指令')
  assert.equal(activeCancel.blocks, undefined)
  await transport.emitMessage(dispatchEvent({ ts: '100.004', text: '[派单] 第三个活' }))
  await transport.emitMessage(dispatchEvent({ ts: '100.040', threadTs: '100.004', text: '[取消]' }))
  const queuedCancel = transport.postsInThread('100.004').find(post => post.text.includes('已取消'))
  assert.equal(queuedCancel.text, '🛑 已取消（排队中，未执行）。来源：thread 指令')
  assert.equal(queuedCancel.blocks, undefined)

  const failing = new FakeCtx()
  const failTransport = new FakeTransport()
  const failPlugin = createSlackPlugin({
    transport: failTransport,
    tokens: TOKENS,
    logger: { log: () => {} },
  })
  await failPlugin.apply(failing, TEST_CONFIG)
  failing.agents.create = async () => { throw new Error('boom') }
  await failTransport.emitMessage(dispatchEvent({ ts: '100.050' }))
  const failed = failTransport.postsInThread('100.050').find(post => post.text.includes('启动失败'))
  assert.equal(failed.text, '❌ 启动失败：boom')
  assert.equal(failed.blocks, undefined)
  for (const post of [...transport.posts, ...failTransport.posts]) assertNoInteractive(post)
})

test('AC-21 卡片与非交卷回帖的 payload 递归不含 button/actions/action_id', async () => {
  const samples = [
    cardOf(FULL_REPORT),
    cardOf(reportText({ pr: '无：还没 push' })),
    cardOf(reportText({ pr: '稍后补' })),
    cardOf(reportText({ ac: '测'.repeat(4000) })),
    cardOf(`xoxb-leak-token\n${reportText({ pr: '' })}`),
  ]
  for (const payload of samples) {
    assertNoInteractive(payload)
    assertWithinLimits(payload)
    assert.equal(JSON.stringify(payload).includes('action_id'), false)
  }
  const result = await runScenario({ kind: 'slack', finalText: FULL_REPORT })
  for (const call of result.calls) assertNoInteractive(call)
  assert.equal(result.calls.some(call => call.blocks && /已开工|排队|已取消|启动失败/.test(call.text)), false)
})
