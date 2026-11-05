/**
 * dsh 执行桥：把插件的任务对象接到宿主 agents 服务上。
 * 接口依据 deepseek-harness 官方 ACP 实现核准（2026-11-05，刘）：
 *   ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, signal, setup }) -> AgentHandle { agent, dispose() }
 *   ctx.agents.resume({ resumeSessionId, agentOptions, signal, setup })
 *   agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
 *   agent.cancel({ kind: 'user' })
 *   ctx.on('session/event', (session, event) => …)，event.type ∈ turn/start | turn/end | assistant/message …
 * 交卷判定：本任务所有已投喂 turn 都收到 turn/end 时，取最后一条 assistant/message 文本为最终回复。
 */

let cachedCreateUserMessage

async function defaultCreateUserMessage(text) {
  if (cachedCreateUserMessage === undefined) {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      cachedCreateUserMessage = mod.createUserMessage
    } catch {
      cachedCreateUserMessage = null
    }
  }
  if (cachedCreateUserMessage) {
    return cachedCreateUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }
  // 宿主模块不可用时的兜底形状（字段与 createUserMessage 的入参一致，宿主一般能容忍纯数据）。
  return { content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** 防御性地从 session/event 的 assistant/message 事件里抽纯文本（形状随版本可能不同）。 */
export function extractAssistantText(event) {
  const data = event?.data ?? event ?? {}
  if (typeof data.text === 'string') return data.text
  const chunks = data.stream?.chunks ?? data.stream ?? data.chunks
  if (Array.isArray(chunks)) {
    const parts = []
    for (const chunk of chunks) {
      if (typeof chunk === 'string') parts.push(chunk)
      else if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
      else if (chunk?.type === 'text' && typeof chunk.text === 'string') parts.push(chunk.text)
    }
    if (parts.length > 0) return parts.join('')
  }
  const content = data.message?.content ?? data.content
  if (Array.isArray(content)) {
    return content.filter(c => c?.type === 'text').map(c => c.text ?? '').join('')
  }
  return ''
}

export class DshBridge {
  #tasks = new Map() // sessionId -> task runtime

  constructor({ ctx, agentOptions = {}, createUserMessage = defaultCreateUserMessage, onSettled, onEventError }) {
    this.ctx = ctx
    this.agentOptions = agentOptions
    this.createUserMessage = createUserMessage
    this.onSettled = onSettled
    this.onEventError = onEventError
  }

  /** 建（或恢复）session 并投喂首条 prompt。task 需带 sessionId 与 cwd。 */
  async start(task, promptText) {
    const runtime = {
      task,
      handle: undefined,
      agent: undefined,
      pendingTurns: 0,
      lastText: '',
      cancelled: false,
    }
    this.#tasks.set(task.sessionId, runtime)

    const existing = this.ctx.sessions?.get?.(task.sessionId)
    const handle = existing !== undefined && this.ctx.agents.resume
      ? await this.ctx.agents.resume({
          resumeSessionId: task.sessionId,
          agentOptions: this.agentOptions,
          signal: task.signal,
        })
      : await this.ctx.agents.create({
          sessionId: task.sessionId,
          meta: { cwd: task.cwd },
          agentOptions: this.agentOptions,
          signal: task.signal,
        })
    runtime.handle = handle
    runtime.agent = handle.agent
    await this.#feed(runtime, promptText)
    return runtime
  }

  /** thread 追问：投喂同一 session。 */
  async followup(sessionId, text) {
    const runtime = this.#tasks.get(sessionId)
    if (!runtime || runtime.cancelled) return false
    await this.#feed(runtime, text)
    return true
  }

  /** 取消：agent.cancel({ kind: 'user' })，并标记使后续 turn/end 不再触发交卷。 */
  cancel(sessionId) {
    const runtime = this.#tasks.get(sessionId)
    if (!runtime) return false
    runtime.cancelled = true
    try {
      runtime.agent?.cancel?.({ kind: 'user' })
    } catch {
      /* 宿主取消失败不阻塞插件侧收尾 */
    }
    return true
  }

  isCancelled(sessionId) {
    return this.#tasks.get(sessionId)?.cancelled === true
  }

  /** 强制遗忘一个 session 的运行时（插件侧已自行收尾时用，如取消后不等 turn/end）。 */
  forget(sessionId) {
    this.#tasks.delete(sessionId)
  }

  async #feed(runtime, text) {
    const message = await this.createUserMessage(text)
    runtime.pendingTurns += 1
    try {
      runtime.agent.followup(message)
    } catch (error) {
      runtime.pendingTurns -= 1
      throw error
    }
  }

  /** 挂到 ctx.on('session/event') 的处理器。 */
  handleSessionEvent = (session, event) => {
    try {
      const sessionId = session?.id ?? session?.header?.id
      const runtime = sessionId !== undefined ? this.#tasks.get(sessionId) : undefined
      if (!runtime) return
      if (event?.type === 'assistant/message' || event?.type === 'assistant/attempt') {
        const text = extractAssistantText(event)
        if (text) runtime.lastText = text
      } else if (event?.type === 'turn/end') {
        runtime.pendingTurns = Math.max(0, runtime.pendingTurns - 1)
        if (runtime.pendingTurns === 0 && !runtime.cancelled) {
          const finalText = runtime.lastText
          this.#tasks.delete(sessionId)
          this.onSettled?.(runtime.task, finalText)
        } else if (runtime.pendingTurns === 0 && runtime.cancelled) {
          this.#tasks.delete(sessionId)
        }
      }
    } catch (error) {
      this.onEventError?.(error)
    }
  }
}
