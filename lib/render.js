/**
 * 交卷块解析与校验（SPEC 范围 6）。
 * dsh 的最后一条回复必须带「## 交卷」块，六个字段缺一不可；缺失即判不完整。
 */

export const REPORT_FIELDS = [
  { key: 'repo', labels: ['仓库', 'repo'] },
  { key: 'branch', labels: ['分支', 'branch'] },
  { key: 'commit', labels: ['commit', 'Commit', 'COMMIT', '提交'] },
  { key: 'pr', labels: ['PR', 'pr', 'Pr'] },
  { key: 'tests', labels: ['测试', 'tests', 'Tests'] },
  { key: 'ac', labels: ['AC 对照', 'AC对照', 'ac', 'AC'] },
]

export function validateReport(text) {
  const source = String(text ?? '')
  const blockMatch = source.match(/##\s*交卷([\s\S]*)$/)
  const block = blockMatch ? blockMatch[1] : ''
  const fields = {}
  const missing = []

  for (const { key, labels } of REPORT_FIELDS) {
    let value
    if (block) {
      for (const label of labels) {
        const line = block.match(new RegExp(`^\\s*[-*]?\\s*${escapeRegExp(label)}\\s*[:：]\\s*(.+)$`, 'm'))
        if (line) {
          value = line[1].trim()
          break
        }
      }
    }
    if (value === undefined || value === '') missing.push(key)
    else fields[key] = value
  }

  if (fields.commit !== undefined && !/[0-9a-f]{7,40}/i.test(fields.commit)) {
    missing.push('commit-format')
  }

  return { ok: missing.length === 0, fields, missing, block: block.trim() }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 拼派单给 dsh 的首条 prompt：频道上下文 + 任务 + 定仓开工指引 + 纪律 + 交卷格式合同。
 * 派单解析到仓库时写明「指定仓库」行，该指定优先于频道上下文推断；
 * 未解析到仓库时不写该行，由 dsh 读频道上下文自行定仓（插件不代拉仓）。
 */
export function buildDispatchPrompt({ issueUrl, body, workdir, repo }, contextText = '') {
  const specifiedRepo = typeof repo === 'string' && repo.length > 0 ? repo : ''
  const lines = [
    '你接到一个来自 Slack 的任务。',
    ...(specifiedRepo ? [`指定仓库：${specifiedRepo}（派单指定，优先于频道上下文推断）。`] : []),
    ...(contextText ? ['', contextText] : []),
    ...(specifiedRepo || contextText ? [''] : []),
    issueUrl ? `Issue：${issueUrl}` : 'Issue：无（以任务描述为准）',
    '',
    '任务描述：',
    body && body.length > 0 ? body : '（见 Issue 链接）',
    '',
    '定仓与开工（插件不代劳，由你完成）：',
    ...(specifiedRepo
      ? [
          `- 本单仓库以派单指定的「${specifiedRepo}」为准，优先于频道上下文里推断出的仓库；流程规范仍可参考频道上下文。`,
          `- 仓库不在本机时，先在工作目录 ${workdir} 下 git clone 该指定仓库；已在本机则进仓并 git pull 到最新，再开工。`,
        ]
      : [
          '- 先读上面的频道上下文：主题/说明里通常写了仓库地址与开发流程规范，按它执行。',
          `- 仓库不在本机时，先在工作目录 ${workdir} 下 git clone 上下文给出的仓库地址；已在本机则进仓并 git pull 到最新，再开工。`,
          '- 上下文与任务都没写明仓库时，在回复中说明缺什么并停下，不要猜仓乱改。',
        ]),
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
