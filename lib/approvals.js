/**
 * 人工审批往返（SPEC 范围 8 的 ask 档）。
 * 插件在 thread 里发出询问后，等待用户以回复（准/驳）或表情（✅/🚫）作答；
 * 超时按驳回处理。post 由插件注入（负责真正的 Slack 发送），本类只管状态与计时。
 */
export class ApprovalManager {
  #pending = new Map() // id -> { threadKey, resolve, timer, messageTs }

  constructor({ timeoutMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
    this.timeoutMs = timeoutMs
    this.now = now
    this.seq = 0
  }

  /** 发起一次审批，返回 Promise<boolean>（true=准）。post(summary) 负责发送并可回传消息 ts。 */
  async request({ threadKey, summary, post }) {
    const id = `ap-${++this.seq}-${this.now()}`
    const promise = new Promise(resolve => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve(false)
      }, this.timeoutMs)
      this.#pending.set(id, { threadKey, resolve, timer, messageTs: undefined })
    })
    if (post) {
      const ts = await post(summary, id)
      const entry = this.#pending.get(id)
      if (entry && ts) entry.messageTs = ts
    }
    return promise
  }

  /** 按 thread 解决该 thread 下最早的待审批（回复作答走这里）。 */
  resolveByThread(threadKey, answer) {
    for (const [id, entry] of this.#pending) {
      if (entry.threadKey === threadKey) {
        this.#settle(id, answer)
        return true
      }
    }
    return false
  }

  /** 按审批消息 ts 解决（表情作答走这里）。 */
  resolveByMessage(messageTs, answer) {
    for (const [id, entry] of this.#pending) {
      if (entry.messageTs === messageTs) {
        this.#settle(id, answer)
        return true
      }
    }
    return false
  }

  hasPendingForThread(threadKey) {
    for (const entry of this.#pending.values()) {
      if (entry.threadKey === threadKey) return true
    }
    return false
  }

  #settle(id, answer) {
    const entry = this.#pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.#pending.delete(id)
    entry.resolve(answer)
  }
}
