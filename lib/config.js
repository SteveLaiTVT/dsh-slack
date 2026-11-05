/**
 * 插件配置校验（手动校验，不依赖宿主的 schemastery，保证可独立测试）。
 * token 只接受环境变量名引用，禁止明文写进配置对象后落盘。
 *
 * v0.3 起极简化（个人项目自用）：
 * - 没有 allowedUserIds：workspace 内任何成员都能 cue，不做发送者白名单。
 * - 没有 channelRepos / channelId / repoRoots：bot 被拉进的任何频道都能接单；
 *   仓库与流程规范由 dsh 读「频道上下文」（主题/说明/近期消息）自行判断，
 *   插件不做频道→仓库映射、不代拉仓库（v0.2 的 AC-12/AC-13 就此废止）。
 * - 唯一实质配置是 workdir：dsh session 的统一工作目录，dsh 在它下面 clone/进仓干活。
 * - 不拦截工具执行、不做工具审批（v0.4 起删除）：插件只接单、执行、交卷。
 * - v0.1/v0.2 的旧字段出现在配置里时直接忽略，不报错——老配置无需改动即可启动。
 */

export class ConfigError extends Error {}

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

export function validateConfig(raw = {}) {
  const config = { ...raw }

  const workdir = config.workdir ?? process.cwd()
  if (typeof workdir !== 'string' || !ABSOLUTE_PATH.test(workdir)) {
    throw new ConfigError(`workdir 不是绝对路径：${String(workdir)}`)
  }
  config.workdir = workdir

  // token 来源：配置里给环境变量名，运行期从 env 读，配置对象本身不保存明文。
  config.appTokenEnv = config.appTokenEnv ?? 'DSH_SLACK_APP_TOKEN'
  config.botTokenEnv = config.botTokenEnv ?? 'DSH_SLACK_BOT_TOKEN'

  config.queueLimit = positiveInt(config.queueLimit, 5, 'queueLimit')
  config.rescanHours = positiveInt(config.rescanHours, 24, 'rescanHours')
  // 频道初始化时读多少条近期消息、上下文块上限、缓存刷新间隔。
  config.contextMessages = positiveInt(config.contextMessages, 20, 'contextMessages')
  config.contextMaxChars = positiveInt(config.contextMaxChars, 6000, 'contextMaxChars')
  config.contextRefreshMinutes = positiveInt(config.contextRefreshMinutes, 60, 'contextRefreshMinutes')
  config.dispatchMarker = config.dispatchMarker ?? '[派单]'
  config.agentOptions = config.agentOptions ?? {}

  return config
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
