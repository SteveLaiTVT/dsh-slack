import assert from 'node:assert/strict'
import test from 'node:test'
import { isDispatchText, parseDispatch, parseThreadCommand} from '../lib/parse.js'

test('isDispatchText：[派单] 与 @bot 触发，普通消息不触发', () => {
assert.equal(isDispatchText('[派单] 干活', 'UBOT'), true)
assert.equal(isDispatchText('【派单】干活', 'UBOT'), true)
assert.equal(isDispatchText('<@UBOT> 干活', 'UBOT'), true)
assert.equal(isDispatchText('随便聊聊', 'UBOT'), false)
assert.equal(isDispatchText(undefined, 'UBOT'), false)
})

test('parseDispatch：标签格式拆出 repo / issue / 正文', () => {
const r = parseDispatch('[派单] 仓库：demo Issue：https://cnb.cool/x/demo/issues/1 把按钮文案改掉')
assert.equal(r.repo, 'demo')
assert.equal(r.issueUrl, 'https://cnb.cool/x/demo/issues/1')
assert.match(r.body, /把按钮文案改掉/)
assert.doesNotMatch(r.body, /仓库/)
})

test('parseDispatch：无标签时从 issue URL 推 repo', () => {
const r = parseDispatch('[派单] https://github.com/acme/widgets/issues/42 修一下')
assert.equal(r.repo, 'widgets')
assert.equal(r.issueUrl, 'https://github.com/acme/widgets/issues/42')
})

test('parseDispatch：什么都没有时 repo 为 undefined', () => {
const r = parseDispatch('[派单] 帮我把文档错别字修了')
assert.equal(r.repo, undefined)
assert.equal(r.issueUrl, undefined)
})

test('parseThreadCommand：取消 / 状态 / 追问', () => {
assert.equal(parseThreadCommand('[取消]').kind, 'cancel')
assert.equal(parseThreadCommand('状态').kind, 'status')
const f = parseThreadCommand('顺便把标题也改了')
assert.equal(f.kind, 'followup')
assert.equal(f.text, '顺便把标题也改了')
})

