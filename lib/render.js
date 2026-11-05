/**
 * 交卷块解析与校验、交卷卡片组装（SPEC 范围 6，issue #1）。
 * dsh 的最后一条回复必须带「## 交卷」块。ok／标题「字段齐全」只表示六字段可解析且格式通过，
 * 不表示测试通过或可合并。
 * 围栏按 CommonMark：字符为反引号或波浪号、长度 ≥ 3；闭合必须同字符且长度 ≥ 开围栏。
 * 围栏内的行不参与识别（块起始、字段头、以及围栏内的 # / ## 不结束块）。
 * 一旦进入围栏外的真交卷块，围栏内的行是当前字段的续行，必须计入字段值。
 * 交卷块在下一个围栏外的 # / ## 标题处结束，其后内容不作字段续行。
 *
 * buildReportCard 管线（顺序不可换）：
 * ① 脱敏：动态值先过 redact，再做任何转义或链接包装。
 * ② 上下文：文本做 Slack 转义（&amp; 先行，再 &lt;、&gt;）；URL 只收 R3 已校验的 http(s)，不 HTML 转义。
 * ③ 包装：程序拼 `<url|打开 PR>`，包装结果不再转义。
 * ④ 预算：只截断未包装的动态值（预算预留转义膨胀、链接包装、省略标记），再拼 text／blocks。
 * ⑤ 终检：复查脱敏、转义与逐 block 长度；不合格则缩短动态值回到 ④，不带病返回。
 */
import { createRedactor } from './redact.js'

export const REPORT_FIELDS = [
  { key: 'repo', labels: ['仓库', 'repo'] },
  { key: 'branch', labels: ['分支', 'branch'] },
  { key: 'commit', labels: ['commit', 'Commit', 'COMMIT', '提交'] },
  { key: 'pr', labels: ['PR', 'pr', 'Pr'] },
  { key: 'tests', labels: ['测试', 'tests', 'Tests'] },
  { key: 'ac', labels: ['AC 对照', 'AC对照', 'ac', 'AC'] },
]

/** 卡片上六字段的固定展示标签（与 REPORT_FIELDS 的 key 对齐）。 */
const FIELD_LABEL = {
  repo: '仓库',
  branch: '分支',
  commit: 'Commit',
  pr: 'PR',
  tests: '测试',
  ac: 'AC 对照',
}

const TITLE_OK = '交卷（字段齐全）'
const TITLE_BAD = '交卷不完整'
const PR_LINK_LABEL = '打开 PR'
const MISSING_SLOT = '—'

/** Slack 硬顶：header 150、section 3000、chat.postMessage text 40000。 */
export const REPORT_CARD_LIMITS = {
  header: 150,
  section: 3000,
  text: 40000,
}

export const REPORT_TRUNCATION_MARK = '…（已截断）'

const LABEL_MATCHERS = REPORT_FIELDS
  .flatMap(({ key, labels }) => labels.map(label => ({
    key,
    label,
    re: new RegExp(`^\\s*[-*]?\\s*${escapeRegExp(label)}\\s*[:：]\\s*(.*)$`),
  })))
  .sort((a, b) => b.label.length - a.label.length)

const HEADING_RE = /^\s*##\s*交卷\s*$/
/** 同级（##）或更高（#）的 ATX 标题。### 及以下不结束交卷块。只在围栏外生效。 */
const BLOCK_END_RE = /^\s*#{1,2}(?!#)/
/** 行首最多 3 个空格或 tab，然后是至少 3 个同字符的 ` 或 ~。 */
const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/
const HEX40_RE = /^[0-9a-fA-F]{40}$/
const ALLOWED_BLOCK_TYPES = new Set(['header', 'section', 'divider', 'context'])
const INTERACTIVE_TYPES = new Set([
  'actions', 'button', 'static_select', 'multi_static_select', 'overflow', 'datepicker',
  'timepicker', 'radio_buttons', 'checkboxes', 'plain_text_input', 'users_select',
  'multi_users_select', 'conversations_select', 'multi_conversations_select',
  'channels_select', 'multi_channels_select', 'external_select', 'multi_external_select',
  'workflow_button', 'rich_text_input',
])

/**
 * 推进 CommonMark 围栏状态。
 * open：开围栏（分隔行，不是字段内容）。
 * close：同字符且长度 ≥ 开围栏，行尾只剩空白。
 * inside：当前开着的围栏里的内容行。
 * text：围栏外的普通行。
 */
function advanceFence(open, line) {
  const marker = fenceMarker(line)
  if (!open) {
    if (marker && !(marker.char === '`' && marker.rest.includes('`'))) {
      return { open: { char: marker.char, len: marker.len }, kind: 'open' }
    }
    return { open: null, kind: 'text' }
  }
  if (marker && marker.char === open.char && marker.len >= open.len && /^[ \t]*$/.test(marker.rest)) {
    return { open: null, kind: 'close' }
  }
  return { open, kind: 'inside' }
}

function fenceMarker(line) {
  const match = FENCE_LINE_RE.exec(line)
  if (!match) return null
  return { char: match[1][0], len: match[1].length, rest: match[2] }
}

export function validateReport(text) {
  const source = String(text ?? '')
  const lines = source.split(/\r?\n/)
  const headingAt = []
  let open = null
  for (let i = 0; i < lines.length; i++) {
    const step = advanceFence(open, lines[i])
    open = step.open
    if (step.kind === 'text' && HEADING_RE.test(lines[i])) headingAt.push(i)
  }
  if (headingAt.length >= 2) return ambiguousBlock(source)
  if (headingAt.length === 0) {
    return {
      ok: false,
      fields: {},
      missing: REPORT_FIELDS.map(field => field.key),
      ambiguous: false,
      ambiguousFields: [],
      ambiguity: undefined,
      prKind: undefined,
      block: '',
    }
  }
  // 记录到的标题一定在围栏外，块内从「未进围栏」继续扫。
  // 围栏分隔行不进字段值；围栏内的行不识别为字段头或块结束，但计入当前字段的续行。
  const blockLines = []
  const inside = []
  open = null
  for (let i = headingAt[0] + 1; i < lines.length; i++) {
    const step = advanceFence(open, lines[i])
    open = step.open
    if (step.kind === 'open' || step.kind === 'close') continue
    if (step.kind === 'text' && BLOCK_END_RE.test(lines[i])) break
    blockLines.push(lines[i])
    inside.push(step.kind === 'inside')
  }
  return parseBlock(blockLines, inside)
}

/**
 * 组装交卷卡片终态。返回 { text, blocks }，调用方直送 transport，不再截断或转义。
 * report 为 validateReport 的结果；originalText 只在不完整卡上附上（先脱敏再截断）。
 */
export function buildReportCard({ report, originalText = '', redact } = {}) {
  if (!report || typeof report.fields !== 'object') {
    throw new Error('buildReportCard: 缺少 validateReport 结果')
  }
  const redactFn = typeof redact === 'function' ? redact : createRedactor()
  let scale = 1
  let lastProblem = '未组装'
  for (let attempt = 0; attempt < 8; attempt++) {
    const payload = assembleReportCard({ report, originalText, redact: redactFn, scale })
    const problem = inspectReportPayload(payload, redactFn)
    if (!problem) return payload
    lastProblem = problem
    scale /= 2
  }
  throw new Error(`交卷卡片未通过出站终检：${lastProblem}`)
}

function ambiguousBlock(source) {
  const keys = REPORT_FIELDS.map(field => field.key)
  return {
    ok: false,
    fields: {},
    missing: keys,
    ambiguous: true,
    ambiguousFields: keys,
    ambiguity: 'duplicate-block',
    prKind: undefined,
    block: source.trim(),
  }
}

function parseBlock(blockLines, inside = []) {
  const occurrences = new Map(REPORT_FIELDS.map(field => [field.key, []]))
  let current = null
  const flush = () => {
    if (!current) return
    occurrences.get(current.key).push([current.first, ...current.rest].join('\n').trim())
    current = null
  }
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i]
    const matched = inside[i] ? null : matchLabelLine(line)
    if (matched) {
      flush()
      current = { key: matched.key, first: matched.value, rest: [] }
    } else if (current) {
      current.rest.push(line)
    }
  }
  flush()

  const fields = {}
  const missing = []
  const ambiguousFields = []
  let prKind
  for (const { key } of REPORT_FIELDS) {
    const unique = [...new Set(occurrences.get(key))]
    if (unique.length > 1) {
      ambiguousFields.push(key)
      continue
    }
    if (unique.length === 0 || unique[0] === '') {
      missing.push(key)
      continue
    }
    const value = unique[0]
    fields[key] = value
    if (key === 'commit' && !HEX40_RE.test(value)) missing.push('commit-format')
    if (key === 'pr') {
      prKind = classifyPr(value)
      if (prKind === 'invalid') missing.push('pr-format')
    }
  }
  const ambiguous = ambiguousFields.length > 0
  return {
    ok: missing.length === 0 && !ambiguous,
    fields,
    missing,
    ambiguous,
    ambiguousFields,
    ambiguity: ambiguous ? 'duplicate-field' : undefined,
    prKind,
    block: blockLines.join('\n').trim(),
  }
}

function matchLabelLine(line) {
  for (const matcher of LABEL_MATCHERS) {
    const found = matcher.re.exec(line)
    if (found) return { key: matcher.key, value: found[1] }
  }
  return null
}

function classifyPr(value) {
  if (isSafeHttpUrl(value)) return 'url'
  if (isWuWithReason(value)) return 'wu'
  return 'invalid'
}

/** R3：整值是 http(s) URL，且不含空白、`<`、`>`、`|`（这些会拆坏 mrkdwn 链接）。 */
function isSafeHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (!/^https?:\/\//i.test(value)) return false
  if (/[\s<>|]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isWuWithReason(value) {
  if (!value.startsWith('无')) return false
  const rest = value.slice(1).trim()
  if (!rest) return false
  const reason = rest.replace(/^[：:，,。．.、\-—~～\s（(【\[]+/, '').trim()
  return reason.length > 0
}

function assembleReportCard({ report, originalText, redact, scale }) {
  const title = report.ok ? TITLE_OK : TITLE_BAD
  const slots = {}
  for (const { key } of REPORT_FIELDS) {
    slots[key] = renderSlot(report, key, redact, bodyBudget(FIELD_LABEL[key], scale))
  }
  const issueItems = report.ok ? null : listIssues(report)
  const issueBody = issueItems
    ? fitEscaped(issueItems.join('、'), bodyBudget('缺项', scale)).text
    : null
  const originalBody = report.ok
    ? null
    : renderOriginal(originalText, redact, bodyBudget('原文', scale))

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title } },
    { type: 'divider' },
  ]
  if (issueBody !== null) blocks.push(sectionBlock('缺项', issueBody))
  for (const { key } of REPORT_FIELDS) blocks.push(sectionBlock(FIELD_LABEL[key], slots[key]))
  if (originalBody !== null) {
    blocks.push({ type: 'divider' })
    blocks.push(sectionBlock('原文', originalBody))
  }

  const lines = [title]
  if (issueBody !== null) lines.push(`缺项：${issueBody}`)
  for (const { key } of REPORT_FIELDS) lines.push(`${FIELD_LABEL[key]}：${slots[key]}`)
  if (originalBody !== null) lines.push(`原文：${originalBody}`)
  return { text: lines.join('\n'), blocks }
}

function listIssues(report) {
  if (report.ambiguity === 'duplicate-block') return ['解析歧义']
  const items = []
  for (const { key } of REPORT_FIELDS) {
    const label = FIELD_LABEL[key]
    if (report.ambiguousFields?.includes(key)) items.push(`${label}（解析歧义）`)
    else if (report.missing?.includes(key)) items.push(`${label}（字段缺失）`)
    else if (key === 'commit' && report.missing?.includes('commit-format')) items.push(`${label}（commit-format）`)
    else if (key === 'pr' && report.missing?.includes('pr-format')) items.push(`${label}（pr-format）`)
  }
  return items
}

function renderSlot(report, key, redact, budget) {
  if (report.ambiguousFields?.includes(key)) return MISSING_SLOT
  const value = report.fields?.[key]
  if (value === undefined || value === '') return MISSING_SLOT
  const redacted = redact(value)
  if (!redacted.trim()) return MISSING_SLOT
  if (key === 'pr' && report.prKind === 'url') return renderPrLink(redacted, budget)
  return fitEscaped(redacted, budget).text
}

function renderPrLink(redacted, budget) {
  // 包装发生在截断判断之后：放得下才包链接；放不下则按普通文本截断，不再当成正常链接。
  if (isSafeHttpUrl(redacted)) {
    const link = `<${redacted}|${PR_LINK_LABEL}>`
    if (link.length <= budget) return link
  }
  return fitEscaped(redacted, budget).text
}

function renderOriginal(originalText, redact, budget) {
  const redacted = redact(String(originalText ?? ''))
  if (!redacted.trim()) return '（无最终回复）'
  return fitEscaped(redacted, budget).text
}

function sectionBlock(label, body) {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${label}*\n${body}` },
  }
}

function bodyBudget(label, scale) {
  const hard = REPORT_CARD_LIMITS.section - `*${label}*\n`.length
  const scaled = Math.floor(hard * scale)
  return Math.max(REPORT_TRUNCATION_MARK.length, Math.min(hard, scaled))
}

/**
 * 截断未转义的动态值，使转义后的长度（含省略标记）不超过 budget。
 * 先截断再转义，避免切断 `&amp;` / `&lt;` / `&gt;`。
 */
function fitEscaped(raw, budget) {
  const full = slackEscape(raw)
  if (full.length <= budget) return { text: full, truncated: false }
  const room = budget - REPORT_TRUNCATION_MARK.length
  if (room <= 0) return { text: REPORT_TRUNCATION_MARK.slice(0, budget), truncated: true }
  let lo = 0
  let hi = raw.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (slackEscape(raw.slice(0, mid)).length <= room) lo = mid
    else hi = mid - 1
  }
  return { text: slackEscape(raw.slice(0, lo)) + REPORT_TRUNCATION_MARK, truncated: true }
}

function slackEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inspectReportPayload(payload, redact) {
  if (typeof payload?.text !== 'string' || !Array.isArray(payload.blocks)) return 'payload 形状不对'
  if (payload.text.length > REPORT_CARD_LIMITS.text) return 'text 超长'
  const interactive = findInteractive(payload.blocks)
  if (interactive) return interactive
  const nodes = [{ text: payload.text, limit: REPORT_CARD_LIMITS.text, where: 'text' }]
  for (const block of payload.blocks) {
    if (!ALLOWED_BLOCK_TYPES.has(block?.type)) return `不允许的 block：${block?.type}`
    if (block.type === 'header') {
      if (block.text?.type !== 'plain_text') return 'header 必须是 plain_text'
      nodes.push({ text: block.text.text ?? '', limit: REPORT_CARD_LIMITS.header, where: 'header' })
    } else if (block.type === 'section') {
      if (block.text?.type !== 'mrkdwn') return 'section 必须是 mrkdwn'
      nodes.push({ text: block.text.text ?? '', limit: REPORT_CARD_LIMITS.section, where: 'section' })
    } else if (block.type === 'context') {
      for (const element of block.elements ?? []) {
        nodes.push({ text: element.text ?? '', limit: 2000, where: 'context' })
      }
    }
  }
  for (const node of nodes) {
    if (typeof node.text !== 'string') return `${node.where} 缺少文本`
    if (node.text.length > node.limit) return `${node.where} 超长`
    if (redact(node.text) !== node.text) return `${node.where} 脱敏未净`
    if (hasUnsafeMarkup(node.text)) return `${node.where} 转义未净`
  }
  return null
}

function hasUnsafeMarkup(text) {
  const stripped = text.replace(/<https?:\/\/[^|\s<>]+\|打开 PR>/g, '')
  if (/[<>]/.test(stripped)) return true
  if (/&(?!amp;|lt;|gt;)/.test(stripped)) return true
  return false
}

function findInteractive(value, path = '$') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findInteractive(value[i], `${path}[${i}]`)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value)) {
    if (key === 'action_id') return `含 action_id（${path}）`
    if (key === 'type' && INTERACTIVE_TYPES.has(child)) return `含交互元素 ${child}（${path}）`
    const found = findInteractive(child, `${path}.${key}`)
    if (found) return found
  }
  return null
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 拼派单给 dsh 的首条 prompt：频道上下文 + 任务 + 定仓开工指引 + 纪律 + 交卷格式合同。
 * v0.3：插件不定仓——上下文块（主题/说明/近期消息）原样带入，由 dsh 自己读出仓库与流程，
 * 需要时自己在 workdir 下 clone。
 */
export function buildDispatchPrompt({ issueUrl, body, workdir }, contextText = '') {
  const lines = [
    '你接到一个来自 Slack 的任务。',
    ...(contextText ? ['', contextText, ''] : []),
    issueUrl ? `Issue：${issueUrl}` : 'Issue：无（以任务描述为准）',
    '',
    '任务描述：',
    body && body.length > 0 ? body : '（见 Issue 链接）',
    '',
    '定仓与开工（插件不代劳，由你完成）：',
    '- 先读上面的频道上下文：主题/说明里通常写了仓库地址与开发流程规范，按它执行。',
    `- 仓库不在本机时，先在工作目录 ${workdir} 下 git clone 上下文给出的仓库地址；已在本机则进仓并 git pull 到最新，再开工。`,
    '- 上下文与任务都没写明仓库时，在回复中说明缺什么并停下，不要猜仓乱改。',
    '',
    '纪律：',
    '- 只在定下的仓库范围内改动；确需偏离时先在回复中说明并停下等追问，不要擅自扩大范围。',
    '- 插件不拦你的工具执行：git push、删除、装依赖按任务需要直接做，但每一步都要能在交卷里交代清楚。',
    '- 完工前必须真实运行测试/构建并记录命令与结果，不许口头声称通过。',
    '- 未 push 到远程分支不算完成。',
    '',
    '最后一条回复必须以下面的交卷块收尾，字段缺一不可（仓库填你实际使用的仓库）：',
    '## 交卷',
    '- 仓库：',
    '- 分支：',
    '- Commit：',
    '- PR：（链接；没有就写「无」并说明原因）',
    '- 测试：（命令 + 通过/失败摘要）',
    '- AC 对照：（逐条对照任务/Issue 的验收标准说明达成情况）',
  ]
  return lines.join('\n')
}
