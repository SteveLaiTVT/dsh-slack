/**
 * 工具执行权限策略（SPEC 范围 8，三档）。
 * 输入是归一化后的执行视图 { toolName, command, argsText, paths }，输出 { action, reason }。
 * 这里只做纯判断：allow / deny / ask；ask 的人工往返由插件层完成。
 */

const CREDENTIAL_PATH = /(^|[\\/])\.(ssh|aws|gnupg)([\\/]|$)|(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)(\.|$)|\.pem$|(^|[\\/])\.env($|\.)/i

const ASK_COMMAND = [
  /\bgit\s+push\b/i,
  /\b(rm\s+-[rf]|del\s+\/|Remove-Item|rmdir\s+\/s)/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b/i,
  /\bpip3?\s+install\b/i,
  /\b(curl|wget|Invoke-WebRequest)\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s)/i,
]

/** 凭据类路径：任何工具碰到都硬拒绝（读也不行）。 */
export function isCredentialPath(p) {
  return CREDENTIAL_PATH.test(String(p).replace(/\\/g, '/'))
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/')
}

/** 路径是否落在任一白名单根内（Windows 盘符大小写不敏感）。 */
export function isInsideRoots(p, roots) {
  const target = normalizePath(p).toLowerCase()
  return Object.values(roots).some(root => {
    const r = normalizePath(root).toLowerCase().replace(/\/$/, '')
    return target === r || target.startsWith(`${r}/`)
  })
}

function looksAbsolute(p) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p)
}

export function evaluatePolicy(exec, { repoRoots }) {
  const paths = exec.paths ?? []

  for (const p of paths) {
    if (isCredentialPath(p)) {
      return { action: 'deny', reason: `凭据类路径禁止访问：${p}` }
    }
  }

  const isWriteTool = /(write|edit|create|delete|remove|move|rename)/i.test(exec.toolName ?? '')
  const isDeleteTool = /(delete|remove)/i.test(exec.toolName ?? '')

  if (isDeleteTool) return { action: 'ask', reason: '删除操作需人工批准' }

  for (const p of paths) {
    if (looksAbsolute(p) && !isInsideRoots(p, repoRoots)) {
      if (isWriteTool) return { action: 'ask', reason: `写入白名单根之外的路径需人工批准：${p}` }
      return { action: 'ask', reason: `访问白名单根之外的路径需人工批准：${p}` }
    }
  }

  const command = exec.command ?? ''
  if (command) {
    for (const pattern of ASK_COMMAND) {
      if (pattern.test(command)) {
        return { action: 'ask', reason: `命令需人工批准（命中 ${pattern.source}）：${command.slice(0, 200)}` }
      }
    }
  }

  return { action: 'allow', reason: '白名单内常规操作' }
}

/**
 * 把宿主的 ToolExecution（形状随版本可能不同）防御性地归一化。
 * 拿不准的字段一律留空——策略对未知形状默认 allow，避免误伤宿主其他插件的调用；
 * 会话归属同理多路探测，探测不到就返回 undefined，上层据此放行不管。
 */
export function normalizeExec(raw) {
  if (raw === null || typeof raw !== 'object') return { toolName: '', command: '', paths: [] }
  const toolName = raw.tool?.name ?? raw.toolName ?? raw.name ?? raw.toolId ?? ''
  const args = raw.args ?? raw.input ?? raw.arguments ?? raw.parameters ?? {}
  const command = typeof args?.command === 'string' ? args.command
    : typeof args?.cmd === 'string' ? args.cmd
      : typeof args?.script === 'string' ? args.script : ''

  const paths = []
  const collect = (value, keyHint = '') => {
    if (typeof value === 'string') {
      if (/(path|file|dir|target|cwd)/i.test(keyHint) || looksAbsolute(value)) paths.push(value)
    } else if (Array.isArray(value)) {
      value.forEach(v => collect(v, keyHint))
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) collect(v, k)
    }
  }
  collect(args)
  if (command) {
    for (const token of command.split(/[\s'"`]+/)) {
      if (looksAbsolute(token)) paths.push(token)
    }
  }

  const sessionId = raw.sessionId ?? raw.session?.id ?? raw.context?.sessionId ?? raw.agent?.session?.id
  return { toolName: String(toolName), command, paths, sessionId }
}
