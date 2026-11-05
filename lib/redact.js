/**
 * 凭据脱敏：任何要进日志或回帖的文本先过这里（SPEC AC-10）。
 * 已知 token 前缀（xoxb/xapp/xoxp/slack 风格）与配置里登记的秘密值都会被抹掉。
 */

const TOKEN_PATTERNS = [
  /xox[bpras]-[A-Za-z0-9-]+/g,
  /xapp-[A-Za-z0-9-]+/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
]

/** 造一个脱敏函数：除了通用模式，还抹掉调用方登记的每个秘密值本身。 */
export function createRedactor(secrets = []) {
  const values = secrets.filter(v => typeof v === 'string' && v.length >= 4)
  return function redact(input) {
    let text = typeof input === 'string' ? input : String(input ?? '')
    for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, '[REDACTED]')
    for (const value of values) text = text.split(value).join('[REDACTED]')
    return text
  }
}

/** 截断长文本，保留头尾，中间注明省略量（回帖防刷屏）。 */
export function truncate(text, limit = 2800) {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.7)
  const tail = limit - head
  return `${text.slice(0, head)}\n…（省略 ${text.length - limit} 字）…\n${text.slice(-tail)}`
}
