/**
 * 插件配置校验（手动校验，不依赖宿主的 schemastery，保证可独立测试）。
 * 字段与 SPEC「配置项」一一对应；token 只接受环境变量名引用，禁止明文写进配置对象后落盘。
 *
 * 频道→仓库映射（v0.2 起）：
 * - 新写法：`channelRepos: { <channelId>: { repo, root, remote?, branch?, sync? } }`
 *   或等价数组 `channels: [{ channelId, repo, root, remote?, branch?, sync? }]`。
 *   一个频道绑定一个仓库：在该频道派单不用再写「仓库：」，插件按频道定仓，
 *   开工前按映射把仓库 clone（本地缺失）/ pull --ff-only（已存在且配了 remote）。
 * - 旧写法（兼容）：单 `channelId` + `repoRoots{ repo: root }`，仓库由派单正文指定。
 * 两者可混用：channelRepos 里的 root 会并入 repoRoots 白名单（同 repo 两个不同 root 直接报错）。
 */

export class ConfigError extends Error {}

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

export function validateConfig(raw = {}) {
  const config = { ...raw }

  if (config.allowedUserIds === undefined) {
    throw new ConfigError('缺少必填配置：allowedUserIds')
  }
  if (!Array.isArray(config.allowedUserIds) || config.allowedUserIds.length === 0) {
    throw new ConfigError('allowedUserIds 必须是非空数组（只认这些发送者的派单）')
  }

  const hasLegacy = config.channelId !== undefined || config.repoRoots !== undefined
  const hasMapping = config.channelRepos !== undefined || config.channels !== undefined
  if (!hasLegacy && !hasMapping) {
    throw new ConfigError('缺少必填配置：需要 channelRepos/channels（频道→仓库映射）或旧式 channelId + repoRoots')
  }

  // --- 旧式 repoRoots ---
  const repoRoots = {}
  if (config.repoRoots !== undefined) {
    if (typeof config.repoRoots !== 'object' || config.repoRoots === null || Object.keys(config.repoRoots).length === 0) {
      throw new ConfigError('repoRoots 必须是非空映射表（repo 标识 -> 本机绝对路径）')
    }
    for (const [repo, root] of Object.entries(config.repoRoots)) {
      assertAbsolute(root, `repoRoots.${repo}`)
      repoRoots[repo] = root
    }
  }

  // --- 频道→仓库映射，归一化为 channelMap ---
  const channelMap = {}
  const addMapping = (channelId, entry) => {
    if (typeof channelId !== 'string' || channelId.length === 0) {
      throw new ConfigError('频道映射的 channelId 必须是非空字符串')
    }
    if (channelMap[channelId]) throw new ConfigError(`频道 ${channelId} 被重复映射`)
    if (entry === null || typeof entry !== 'object') {
      throw new ConfigError(`频道 ${channelId} 的映射必须是对象 { repo, root, remote?, branch? }`)
    }
    const { repo, root, remote, branch, sync } = entry
    if (typeof repo !== 'string' || repo.length === 0) {
      throw new ConfigError(`频道 ${channelId} 的映射缺少 repo`)
    }
    assertAbsolute(root, `频道 ${channelId} 映射的 root`)
    if (remote !== undefined && (typeof remote !== 'string' || remote.length === 0)) {
      throw new ConfigError(`频道 ${channelId} 的 remote 必须是非空字符串（仓库远程地址）`)
    }
    if (branch !== undefined && (typeof branch !== 'string' || branch.length === 0)) {
      throw new ConfigError(`频道 ${channelId} 的 branch 必须是非空字符串`)
    }
    if (sync !== undefined && !['auto', 'off'].includes(sync)) {
      throw new ConfigError(`频道 ${channelId} 的 sync 只支持 'auto' | 'off'`)
    }
    // 同一个 repo 只能对应一个本机根目录，否则白名单与 cwd 会打架。
    if (repoRoots[repo] !== undefined && repoRoots[repo] !== root) {
      throw new ConfigError(`repo ${repo} 有两个不同的根目录：${repoRoots[repo]} 与 ${root}`)
    }
    repoRoots[repo] = root
    channelMap[channelId] = { channelId, repo, root, remote, branch, sync: sync ?? 'auto' }
  }

  if (config.channelRepos !== undefined) {
    if (typeof config.channelRepos !== 'object' || config.channelRepos === null || Object.keys(config.channelRepos).length === 0) {
      throw new ConfigError('channelRepos 必须是非空映射表（channelId -> { repo, root, remote?, branch? }）')
    }
    for (const [channelId, entry] of Object.entries(config.channelRepos)) addMapping(channelId, entry)
  }
  if (config.channels !== undefined) {
    if (!Array.isArray(config.channels) || config.channels.length === 0) {
      throw new ConfigError('channels 必须是非空数组（[{ channelId, repo, root, remote?, branch? }]）')
    }
    for (const entry of config.channels) {
      if (entry === null || typeof entry !== 'object') throw new ConfigError('channels 的每一项必须是对象')
      const { channelId, ...rest } = entry
      addMapping(channelId, rest)
    }
  }

  // --- 旧式单频道：仓库不绑频道，由派单正文指定 ---
  if (config.channelId !== undefined) {
    if (typeof config.channelId !== 'string' || config.channelId.length === 0) {
      throw new ConfigError('channelId 必须是非空字符串')
    }
    if (Object.keys(repoRoots).length === 0) {
      throw new ConfigError('使用旧式 channelId 时必须同时给出 repoRoots')
    }
    if (!channelMap[config.channelId]) {
      channelMap[config.channelId] = { channelId: config.channelId, repo: undefined, root: undefined, remote: undefined, branch: undefined, sync: 'off' }
    }
  }

  config.repoRoots = repoRoots
  config.channelMap = channelMap
  config.channelIds = Object.keys(channelMap)
  // 兼容旧字段：单频道时仍给出 channelId，多频道时为映射中的第一个（仅供日志/旧代码参考，路由以 channelMap 为准）。
  config.channelId = config.channelId ?? config.channelIds[0]

  // token 来源：配置里给环境变量名，运行期从 env 读，配置对象本身不保存明文。
  config.appTokenEnv = config.appTokenEnv ?? 'DSH_SLACK_APP_TOKEN'
  config.botTokenEnv = config.botTokenEnv ?? 'DSH_SLACK_BOT_TOKEN'

  config.approvalTimeoutMinutes = positiveInt(config.approvalTimeoutMinutes, 30, 'approvalTimeoutMinutes')
  config.queueLimit = positiveInt(config.queueLimit, 5, 'queueLimit')
  config.rescanHours = positiveInt(config.rescanHours, 24, 'rescanHours')
  config.dispatchMarker = config.dispatchMarker ?? '[派单]'
  config.agentOptions = config.agentOptions ?? {}

  return config
}

function assertAbsolute(root, label) {
  if (typeof root !== 'string' || !ABSOLUTE_PATH.test(root)) {
    throw new ConfigError(`${label} 不是绝对路径：${String(root)}`)
  }
}

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${name} 必须是正整数`)
  return value
}

/** 从环境读 token；读不到就报错（启动即失败，胜过连不上再猜）。 */
export function readTokens(config, env = process.env) {
  const appToken = env[config.appTokenEnv]
  const botToken = env[config.botTokenEnv]
  if (!appToken) throw new ConfigError(`环境变量 ${config.appTokenEnv} 未设置（App-Level Token xapp-…）`)
  if (!botToken) throw new ConfigError(`环境变量 ${config.botTokenEnv} 未设置（Bot Token xoxb-…）`)
  return { appToken, botToken }
}
