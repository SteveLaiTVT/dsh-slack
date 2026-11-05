import assert from 'node:assert/strict'
import test from 'node:test'
import { validateConfig } from '../lib/config.js'
import { createSlackPlugin } from '../lib/plugin.js'
import { RepoManager, RepoSyncError } from '../lib/repos.js'
import { dispatchEvent, FakeCtx, FakeRepoManager, FakeTransport, TEST_MAPPED_CONFIG } from './helpers.js'

test('config channelRepos：归一化 channelMap、root 并入白名单、旧式兼容不变', () => {
  const c = validateConfig(TEST_MAPPED_CONFIG)
  assert.equal(c.channelMap.C1.repo, 'demo')
  assert.equal(c.channelMap.C2.repo, 'vault')
  assert.equal(c.channelMap.C2.remote, 'https://example.com/x/vault.git')
  assert.equal(c.repoRoots.vault, 'D:/repos/vault')
  assert.deepEqual(c.channelIds, ['C1', 'C2'])

  const legacy = validateConfig({ channelId: 'C9', allowedUserIds: ['U'], repoRoots: { a: 'D:/repos/a' } })
  assert.equal(legacy.channelMap.C9.repo, undefined)
  assert.equal(legacy.channelMap.C9.sync, 'off')
})

test('config channels 数组形式与 channelRepos 等价；重复频道与同仓双根报错', () => {
  const c = validateConfig({
    allowedUserIds: ['U'],
    channels: [{ channelId: 'C1', repo: 'demo', root: 'D:/repos/demo' }],
  })
  assert.equal(c.channelMap.C1.repo, 'demo')
  assert.throws(() => validateConfig({
    allowedUserIds: ['U'],
    channelRepos: {
      C1: { repo: 'demo', root: 'D:/repos/demo' },
      C2: { repo: 'demo', root: 'D:/other/demo' },
    },
  }), /两个不同的根目录/)
  assert.throws(() => validateConfig({
    allowedUserIds: ['U'],
    channelRepos: { C1: { repo: 'demo', root: 'relative/path' } },
  }), /不是绝对路径/)
  assert.throws(() => validateConfig({
    allowedUserIds: ['U'],
    channelRepos: { C1: { root: 'D:/repos/demo' } },
  }), /缺少 repo/)
})

test('RepoManager：缺失+remote -> clone（带 branch）；已存+remote -> pull --ff-only', async () => {
  const calls = []
  const runGit = async (args) => { calls.push(args); return { stdout: '', stderr: '' } }

  const missing = new RepoManager({ runGit, pathExists: () => false })
  const cloned = await missing.ensure({ repo: 'vault', root: 'D:/repos/vault', remote: 'https://x/vault.git', branch: 'main', sync: 'auto' })
  assert.equal(cloned.action, 'cloned')
  assert.deepEqual(calls[0], ['clone', '--branch', 'main', 'https://x/vault.git', 'D:/repos/vault'])

  calls.length = 0
  const present = new RepoManager({ runGit, pathExists: () => true })
  const pulled = await present.ensure({ repo: 'vault', root: 'D:/repos/vault', remote: 'https://x/vault.git', sync: 'auto' })
  assert.equal(pulled.action, 'pulled')
  assert.deepEqual(calls[0], ['-C', 'D:/repos/vault', 'pull', '--ff-only'])
})

test('RepoManager：无 remote 已存跳过、无 remote 缺失报错、目录非 git 仓报错、pull 失败报错', async () => {
  const runGit = async () => ({ stdout: '', stderr: '' })
  const present = new RepoManager({ runGit, pathExists: () => true })
  assert.equal((await present.ensure({ repo: 'a', root: 'D:/a', sync: 'auto' })).action, 'exists')

  const missing = new RepoManager({ runGit, pathExists: () => false })
  await assert.rejects(() => missing.ensure({ repo: 'a', root: 'D:/a', sync: 'auto' }), RepoSyncError)

  const notGit = new RepoManager({ runGit, pathExists: (p) => !p.endsWith('.git') })
  await assert.rejects(() => notGit.ensure({ repo: 'a', root: 'D:/a', remote: 'https://x/a.git', sync: 'auto' }), /不是 git 仓/)

  const failing = new RepoManager({
    runGit: async () => { throw Object.assign(new Error('boom'), { stderr: 'diverged' }) },
    pathExists: () => true,
  })
  await assert.rejects(() => failing.ensure({ repo: 'a', root: 'D:/a', remote: 'https://x/a.git', sync: 'auto' }), /拉取仓库 a 最新代码失败：diverged/)
})

async function mappedSetup(repoManager) {
  const transport = new FakeTransport()
  const ctx = new FakeCtx()
  const plugin = createSlackPlugin({
    transport,
    repoManager,
    tokens: { appToken: 'xapp-test', botToken: 'xoxb-test' },
    logger: { log: () => {} },
  })
  await plugin.apply(ctx, TEST_MAPPED_CONFIG)
  return { transport, ctx }
}

test('AC-12 频道路由：不同频道自动定仓，不写「仓库：」也接单，cwd 与同步映射对应该频道', async () => {
  const repoManager = new FakeRepoManager()
  const { transport, ctx } = await mappedSetup(repoManager)
  await transport.emitMessage(dispatchEvent({
    channel: 'C2',
    text: '[派单] Issue：https://cnb.cool/x/vault/issues/3 把设置页文案改掉',
  }))
  assert.equal(ctx.createdAgents.length, 1)
  assert.equal(ctx.createdAgents[0].cwd, 'D:/repos/vault')
  assert.match(ctx.createdAgents[0].agent.followups[0], /仓库：vault/)
  assert.equal(repoManager.calls.length, 1)
  assert.equal(repoManager.calls[0].repo, 'vault')
  assert.ok(transport.postsInThread('100.001').some(p => /已开工：仓库 vault/.test(p.text)))

  // 未映射频道：无任何反应
  await transport.emitMessage(dispatchEvent({ channel: 'C9', ts: '100.009', text: '[派单] 随便干点啥' }))
  assert.equal(ctx.createdAgents.length, 1)
})

test('AC-12 防串仓：绑定频道里写了别的仓库直接拒单并打 x', async () => {
  const repoManager = new FakeRepoManager()
  const { transport, ctx } = await mappedSetup(repoManager)
  await transport.emitMessage(dispatchEvent({
    channel: 'C2',
    text: '[派单] 仓库：demo 干点活',
  }))
  assert.equal(ctx.createdAgents.length, 0)
  assert.equal(repoManager.calls.length, 0)
  assert.ok(transport.postsInThread('100.001').some(p => /绑定仓库 vault/.test(p.text)))
  assert.ok(transport.reactionsAdded.some(r => r.name === 'x'))
})

test('AC-13 仓库同步失败不开工：回帖说明并释放队列', async () => {
  const repoManager = new FakeRepoManager(async () => { throw new Error('clone 失败：网络不通') })
  const { transport, ctx } = await mappedSetup(repoManager)
  await transport.emitMessage(dispatchEvent({ channel: 'C1', text: '[派单] 干点活' }))
  assert.equal(ctx.createdAgents.length, 0)
  assert.ok(transport.postsInThread('100.001').some(p => /仓库同步失败，本单未开工/.test(p.text)))
})
