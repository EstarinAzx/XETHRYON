/**
 * Swarm event emitter — global, bundler-safe using Symbol.for.
 *
 * Emits task completion/failure events that the TUI can subscribe to
 * for auto-injecting continuation messages to the coordinator.
 *
 * Uses EventTarget (built-in, no dependencies) with globalThis storage
 * to ensure the same instance is used across bundler-duplicated modules.
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
