/**
* 频道上下文服务（v0.3）：频道「初始化」时读一次频道内容，拼成上下文块交给 dsh，
* 由 dsh 自己判断仓库与流程规范——插件不解析、不映射、不代拉仓库。
*
* 读取内容：频道主题（topic）、说明（purpose）、近期消息（默认 20 条）。
* 缓存：按频道缓存；主题/说明变化、或超过刷新间隔（默认 60 分钟）时重读。
* 容错：读不到（缺权限/频道异常）时返回只含频道 id 的最小上下文块，绝不阻塞接单。
*/

export class ChannelContextService {
#cache = new Map() // channelId -> { key, fetchedAt, block}

constructor({ transport, messagesLimit = 20, maxChars = 6000, refreshMs = 60 * 60 * 1000, now = () => Date.now()}) {
this.transport = transport
this.messagesLimit = messagesLimit
this.maxChars = maxChars
this.refreshMs = refreshMs
this.now = now
}

async getContext(channelId) {
let info = null
try {
info = (await this.transport.fetchChannelInfo?.(channelId))?? null
} catch {
info = null
}
const key = `${info?.topic?? ''}\n${info?.purpose?? ''}`
const cached = this.#cache.get(channelId)
if (cached && cached.key === key && this.now() - cached.fetchedAt < this.refreshMs) {
return cached.block
}
let messages = []
try {
messages = (await this.transport.fetchChannelMessages?.(channelId, this.messagesLimit))?? []
} catch {
messages = []
}
let block = formatChannelContext({ channelId, info, messages})
if (block.length > this.maxChars) {
block = `${block.slice(0, this.maxChars)}\n…（频道上下文已按上限截断）`
}
this.#cache.set(channelId, { key, fetchedAt: this.now(), block})
return block
}
}

export function formatChannelContext({ channelId, info, messages}) {
const lines = [
'[频道上下文] 插件在该频道首次接单时自动读取；仓库与流程以这里为准，不要向用户复述本段。',
`频道：${info?.name? `#${info.name}`: channelId}`,
`主题：${info?.topic?.trim()? info.topic.trim(): '（未设置）'}`,
`说明：${info?.purpose?.trim()? info.purpose.trim(): '（未设置）'}`,
'近期消息（旧→新）：',
]
const usable = (messages?? []).filter(m => (m.text?? '').trim().length > 0)
if (usable.length === 0) {
lines.push('（无）')
} else {
for (const m of usable) {
const oneLine = String(m.text).replace(/\s+/g, ' ').trim().slice(0, 300)
lines.push(`- [${m.user?? '?'}] ${oneLine}`)
}
}
lines.push('[/频道上下文]')
return lines.join('\n')
}
