import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePolicy, isInsideRoots, normalizeExec } from '../lib/policy.js'

const ROOTS = { repoRoots: { demo: 'D:/repos/demo' } }

test('AC-06 硬拒绝：.ssh 与 .env 与私钥文件', () => {
  assert.equal(evaluatePolicy({ toolName: 'read', paths: ['C:/Users/x/.ssh/id_rsa'] }, ROOTS).action, 'deny')
  assert.equal(evaluatePolicy({ toolName: 'read', paths: ['D:/repos/demo/.env'] }, ROOTS).action, 'deny')
  assert.equal(evaluatePolicy({ toolName: 'read', paths: ['D:/repos/demo/keys/prod.pem'] }, ROOTS).action, 'deny')
})

test('白名单内常规读写与测试命令放行', () => {
  assert.equal(evaluatePolicy({ toolName: 'write', paths: ['D:/repos/demo/src/a.ts'] }, ROOTS).action, 'allow')
  assert.equal(evaluatePolicy({ toolName: 'bash', command: 'npm test', paths: [] }, ROOTS).action, 'allow')
  assert.equal(evaluatePolicy({ toolName: 'bash', command: 'git commit -m x', paths: [] }, ROOTS).action, 'allow')
})

test('AC-05 ask 档：git push / 装依赖 / 删除 / 白名单外写入', () => {
  assert.equal(evaluatePolicy({ toolName: 'bash', command: 'git push origin feat/x', paths: [] }, ROOTS).action, 'ask')
  assert.equal(evaluatePolicy({ toolName: 'bash', command: 'pnpm install', paths: [] }, ROOTS).action, 'ask')
  assert.equal(evaluatePolicy({ toolName: 'delete_file', paths: ['D:/repos/demo/a.ts'] }, ROOTS).action, 'ask')
  assert.equal(evaluatePolicy({ toolName: 'write', paths: ['C:/Windows/temp/x.txt'] }, ROOTS).action, 'ask')
})

test('isInsideRoots：盘符与斜杠归一', () => {
  assert.equal(isInsideRoots('d:\\repos\\demo\\src\\a.ts', ROOTS.repoRoots), true)
  assert.equal(isInsideRoots('D:/repos/demo2/a.ts', ROOTS.repoRoots), false)
  assert.equal(isInsideRoots('D:/repos/demo', ROOTS.repoRoots), true)
})

test('normalizeExec：多形状防御性归一与会话归属', () => {
  const a = normalizeExec({ tool: { name: 'bash' }, args: { command: 'ls D:/repos/demo' }, sessionId: 's1' })
  assert.equal(a.toolName, 'bash')
  assert.equal(a.command, 'ls D:/repos/demo')
  assert.equal(a.sessionId, 's1')
  assert.ok(a.paths.includes('D:/repos/demo'))
  const b = normalizeExec(null)
  assert.equal(b.toolName, '')
  assert.equal(b.sessionId, undefined)
  const c = normalizeExec({ name: 'read', input: { path: 'D:/repos/demo/a.ts' }, session: { id: 's2' } })
  assert.equal(c.sessionId, 's2')
  assert.ok(c.paths.includes('D:/repos/demo/a.ts'))
})
