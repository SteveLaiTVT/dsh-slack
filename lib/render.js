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

/** 拼派单给 dsh 的首条 prompt：任务 + 纪律 + 交卷格式合同。 */
export function buildDispatchPrompt({ repo, issueUrl, body }) {
  const lines = [
    '你接到一个来自 Slack 派单频道的任务。',
    `仓库：${repo}（当前工作目录已是该仓根目录）`,
    issueUrl ? `Issue：${issueUrl}` : 'Issue：无（以任务描述为准）',
    '',
    '任务描述：',
    body && body.length > 0 ? body : '（见 Issue 链接）',
    '',
    '纪律：',
    '- 只在本仓范围内改动；确需偏离时先在回复中说明并停下等追问，不要擅自扩大范围。',
    '- 涉及 git push、删除文件、安装依赖、白名单外路径时，工具层会转人工审批；被驳回就按驳回理由调整，不要绕过。',
    '- 完工前必须真实运行测试/构建并记录命令与结果，不许口头声称通过。',
    '- 未 push 到远程分支不算完成（push 会触发人工审批，属正常流程）。',
    '',
    '最后一条回复必须以下面的交卷块收尾，字段缺一不可：',
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
