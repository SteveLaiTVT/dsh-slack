/**
 * 仓库同步：按频道→仓库映射，在开工前把该频道绑定的仓库准备到最新。
 * - 本地根目录不存在：配了 remote 就 `git clone`（可带 branch），没配 remote 直接报错拒工。
 * - 本地已是 git 仓：配了 remote 就 `git pull --ff-only` 拉最新；拉失败（脏树/分叉/无网络）
 *   直接报错，由上层回帖并中止本单——不许在旧代码上闷头干。
 * - 没配 remote 且本地已存在：跳过同步（action=exists）。
 * git 与文件系统都可注入，测试用假实现，不碰真实仓库。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class RepoSyncError extends Error {}

async function defaultRunGit(args) {
  const { stdout, stderr } = await execFileAsync('git', args, { timeout: 120_000, windowsHide: true })
  return { stdout: String(stdout), stderr: String(stderr) }
}

export class RepoManager {
  constructor(deps = {}) {
    this.runGit = deps.runGit ?? defaultRunGit
    this.pathExists = deps.pathExists ?? ((p) => existsSync(p))
  }

  /**
   * @param {{ repo: string, root: string, remote?: string, branch?: string, sync?: string }} mapping
   * @returns {Promise<{ action: 'off'|'exists'|'pulled'|'cloned', repo: string, root: string }>}
   */
  async ensure(mapping) {
    const { repo, root, remote, branch } = mapping
    if (mapping.sync === 'off') return { action: 'off', repo, root }

    const isGitRepo = this.pathExists(join(root, '.git'))
    if (!isGitRepo) {
      if (this.pathExists(root)) {
        throw new RepoSyncError(`仓库 ${repo} 的本地目录已存在但不是 git 仓：${root}。请先处理该目录，或改映射 root。`)
      }
      if (!remote) {
        throw new RepoSyncError(`仓库 ${repo} 本地不存在（${root}）且映射未配置 remote，无法拉取。请先在本机 clone，或在频道映射里补 remote。`)
      }
      const args = ['clone']
      if (branch) args.push('--branch', branch)
      args.push(remote, root)
      await this.#git(args, `clone 仓库 ${repo}`)
      return { action: 'cloned', repo, root }
    }

    if (!remote) return { action: 'exists', repo, root }
    const args = ['-C', root, 'pull', '--ff-only']
    if (branch) args.push('origin', branch)
    await this.#git(args, `拉取仓库 ${repo} 最新代码`)
    return { action: 'pulled', repo, root }
  }

  async #git(args, label) {
    try {
      return await this.runGit(args)
    } catch (error) {
      const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 500)
      throw new RepoSyncError(`${label}失败：${detail}`)
    }
  }
}
