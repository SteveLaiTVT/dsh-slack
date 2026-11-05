/**
* 派单解析：从 Slack 消息文本里拆出仓库、issue 链接与任务正文。
* 触发形式（SPEC 范围 2）：@bot，或以 [派单] 开头。
*/

const ISSUE_URL = /https?:\/\/[^\s)]+/g

/** 是否是一条派单消息（顶层消息才算；thread 内的不走这里）。 */
export function isDispatchText(text, botUserId) {
if (typeof text!== 'string') return false
const trimmed = text.trim()
if (trimmed.startsWith('[派单]') || trimmed.startsWith('【派单】')) return true
if (botUserId && trimmed.includes(`<@${botUserId}>`)) return true
return false
}

/**
* 解析派单正文。
* 约定格式（任选）：
* [派单] 仓库：<repo标识> Issue：<url> 正文……
* [派单] <repo标识> <url> 正文……
* 返回 { repo, issueUrl, body}；repo/issueUrl 缺失时为 undefined，是否拒单由上层按配置决定。
*/
export function parseDispatch(text) {
let body = String(text?? '')
.replace(/<@[A-Z0-9]+>/g, ' ')
.replace(/^\s*(\[派单\]|【派单】)\s*/, '')
.trim()

let repo
const repoMatch = body.match(/(?:仓库|repo)\s*[:：]\s*([A-Za-z0-9._/-]+)/i)
if (repoMatch) {
repo = repoMatch[1]
body = body.replace(repoMatch[0], ' ').trim()
}

let issueUrl
const issueMatch = body.match(/(?:issue|Issue|ISSUE)\s*[:：]?\s*(https?:\/\/[^\s)]+)/)
const urls = body.match(ISSUE_URL)?? []
if (issueMatch) {
issueUrl = issueMatch[1]
body = body.replace(issueMatch[0], ' ').trim()
} else if (urls.length > 0) {
issueUrl = urls[0]
}

if (repo === undefined) {
// 无标签时尝试从 issue URL 路径里取倒数第三段作为 repo 标识（…/<owner>/<repo>/issues/<n>）
if (issueUrl) {
const parts = issueUrl.split('/').filter(Boolean)
const issuesIdx = parts.indexOf('issues')
if (issuesIdx >= 1) repo = parts[issuesIdx - 1]
}
}

return { repo, issueUrl, body}
}

/** thread 内控制指令。 */
export function parseThreadCommand(text) {
const trimmed = String(text?? '').trim()
if (trimmed === '[取消]' || trimmed === '取消任务' || trimmed === '/cancel') return { kind: 'cancel'}
if (trimmed === '状态' || trimmed === '[状态]' || trimmed === '/status') return { kind: 'status'}
return { kind: 'followup', text: trimmed}
}

