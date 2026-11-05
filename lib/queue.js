/**
 * 单任务锁 + FIFO 队列（SPEC 范围 9）。
 * 同时只跑一个任务；新任务排队，返回 0 表示立即执行、>0 为排队位次、-1 为超限拒单。
 */
export class TaskQueue {
  #active = undefined
  #waiting = []

  constructor(limit = 5) {
    this.limit = limit
  }

  get active() {
    return this.#active
  }

  get waitingCount() {
    return this.#waiting.length
  }

  /** 入队；返回 { position } —— 0=已成为当前任务（调用方负责启动），>0=排队位次，-1=队列已满。 */
  enqueue(task) {
    if (this.#active === undefined) {
      this.#active = task
      return { position: 0 }
    }
    if (this.#waiting.length >= this.limit) return { position: -1 }
    this.#waiting.push(task)
    return { position: this.#waiting.length }
  }

  /** 当前任务结束，取出下一个（没有则返回 undefined）。 */
  finishActive() {
    const next = this.#waiting.shift()
    this.#active = next
    return next
  }

  /** 从等待队列里摘掉一个任务（如排队中被取消），返回是否摘到。 */
  removeWaiting(predicate) {
    const idx = this.#waiting.findIndex(predicate)
    if (idx === -1) return false
    this.#waiting.splice(idx, 1)
    return true
  }

  /** 按谓词找任务（先当前、后队列）。 */
  find(predicate) {
    if (this.#active !== undefined && predicate(this.#active)) return this.#active
    return this.#waiting.find(predicate)
  }
}
