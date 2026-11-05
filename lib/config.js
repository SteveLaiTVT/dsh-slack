/**
 * 插件配置校验（手动校验，不依赖宿主的 schemastery，保证可独立测试）。
 * 字段与 SPEC「配置项」一一对应；token 只接受环境变量名引用，禁止明文写进配置对象后落盘。
 */

export class ConfigError extends Error {}

const REQUIRED = ['channelId', 'allowedUserIds', 'repoRoots']

export function validateConfig(raw = {}) {
  const config = { ...raw }

  for (const key of REQUIRED) {
    if (config[key] === undefined) throw new ConfigError(`缺少必填配置：${key}`)
  }
  if (typeof config.channelId !== 'string' || config.channelId.length === 0) {
    throw new ConfigError('channelId 必须是非空字符串')
  }
  if (!Array.isArray(config.allowedUserIds) || config.allowedUserIds.length === 0) {
    throw new ConfigError('allowedUserIds 必须是非空数组（只认这些发送者的派单）')
  }
  if (typeof config.repoRoots !== 'object' || config.repoRoots === null || Object.keys(config.repoRoots).length === 0) {
    throw new ConfigError('repoRoots 必须是非空映射表（repo 标识 -> 本机绝对路径）')
  }
  for (const [repo, root] of Object.entries(config.repoRoots)) {
    if (typeof root !== 'string' || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(root)) {
      throw new ConfigError(`repoRoots.${repo} 不是绝对路径：${String(root)}`)
    }
  }

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
