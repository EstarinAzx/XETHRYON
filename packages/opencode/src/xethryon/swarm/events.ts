/**
 * Swarm event emitter — global, bundler-safe using Symbol.for.
 *
 * Emits task completion/failure events and handles auto-injection
 * into the coordinator session via the internal prompt_async endpoint.
 *
 * Architecture (inspired by opencode-ensemble):
 * - Events are emitted from spawn.ts after task verification
 * - A debounced handler batches concurrent completions (3s window)
 * - When the debounce fires, it calls prompt_async to inject a
 *   continuation message into the coordinator's session
 * - This is a server-side mechanism — no TUI involvement required
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwarmTaskEvent {
  teamName: string
  taskId: string
  taskSubject: string
  owner: string
  status: "completed" | "failed"
  wrote: string[]
  notes: string[]
  /** Snapshot: how many tasks are done vs total */
  progress: { done: number; total: number }
  /** The coordinator/lead session ID to inject into */
  coordinatorSessionId?: string
}

// ---------------------------------------------------------------------------
// Global event emitter (bundler-safe)
// ---------------------------------------------------------------------------

const EMITTER_KEY = Symbol.for("xethryon.swarm.eventEmitter")

function getEmitter(): EventTarget {
  if (!(globalThis as any)[EMITTER_KEY]) {
    ;(globalThis as any)[EMITTER_KEY] = new EventTarget()
  }
  return (globalThis as any)[EMITTER_KEY]
}

/**
 * Emit a task completion/failure event.
 * Called from spawn.ts after the verification pipeline finishes.
 */
export function emitTaskDone(detail: SwarmTaskEvent): void {
  getEmitter().dispatchEvent(
    new CustomEvent("swarm:task-done", { detail }),
  )
}

/**
 * Subscribe to task completion/failure events.
 * Returns an unsubscribe function.
 */
export function onTaskDone(callback: (event: SwarmTaskEvent) => void): () => void {
  const handler = (e: Event) => {
    callback((e as CustomEvent<SwarmTaskEvent>).detail)
  }
  getEmitter().addEventListener("swarm:task-done", handler)
  return () => getEmitter().removeEventListener("swarm:task-done", handler)
}

// ---------------------------------------------------------------------------
// Server-side auto-inject (replaces TUI-based createEffect approach)
// ---------------------------------------------------------------------------

interface BufferedEvent {
  subject: string
  owner: string
  status: string
  wrote: string[]
  done: number
  total: number
  coordinatorSessionId?: string
}

let pendingEvents: BufferedEvent[] = []
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const DEBOUNCE_MS = 3000

/**
 * Call the internal prompt_async endpoint to inject a message into
 * the coordinator session. Fire-and-forget — returns immediately.
 */
async function injectPromptAsync(sessionId: string, text: string): Promise<void> {
  try {
    // Dynamic import to avoid circular deps — Server is initialized
    // by the time swarm tasks complete.
    const { Server } = await import("../../server/server.js")
    const server = Server.Default()

    const body = JSON.stringify({
      parts: [{ type: "text", text }],
    })

    const request = new Request(
      `http://localhost/session/${sessionId}/prompt_async`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    )

    const response = await server.fetch(request)
    if (!response.ok) {
      console.error(`[swarm:inject] prompt_async failed: ${response.status}`)
    }
  } catch (err) {
    // Non-fatal — coordinator just won't wake up automatically
    console.error("[swarm:inject] failed to inject:", err)
  }
}

// Subscribe at module load — this runs server-side in the worker process.
onTaskDone((evt) => {
  pendingEvents.push({
    subject: evt.taskSubject,
    owner: evt.owner,
    status: evt.status,
    wrote: evt.wrote,
    done: evt.progress.done,
    total: evt.progress.total,
    coordinatorSessionId: evt.coordinatorSessionId,
  })

  // Debounce: batch concurrent task completions
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null

    const events = [...pendingEvents]
    pendingEvents = []
    if (events.length === 0) return

    // Check autonomy — only inject if enabled
    if (process.env.XETHRYON_AUTONOMY !== "1") return

    // Need a coordinator session ID to inject into
    let sessionId = events.find((e) => e.coordinatorSessionId)?.coordinatorSessionId
    if (!sessionId) {
      // Fallback: read from process.env (set by team_create)
      sessionId = process.env.XETHRYON_COORDINATOR_SESSION ?? undefined
    }
    if (!sessionId) return

    // Build the injection message
    const last = events[events.length - 1]
    const allDone = last.done >= last.total
    const lines = events.map((e) => {
      const emoji = e.status === "completed" ? "✓" : "✗"
      const files = e.wrote.length > 0 ? ` (wrote: ${e.wrote.join(", ")})` : ""
      return `${emoji} ${e.subject} (${e.owner}) ${e.status}${files}`
    })
    const progress = `Progress: ${last.done}/${last.total} done`
    const action = allDone
      ? "All tasks complete. Call team_await to collect final results and summarize."
      : "Call team_await to check your team and take action."
    const text = `[SWARM UPDATE] ${lines.join(" | ")}. ${progress}. ${action}`

    // Fire-and-forget — the server handles the rest
    injectPromptAsync(sessionId, text)
  }, DEBOUNCE_MS)
})
