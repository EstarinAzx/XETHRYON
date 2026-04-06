/**
 * Shared task board for swarm teams.
 * Ported from cc-leak/src/utils/tasks.ts.
 * Stored at .opencode/swarm/{team}/tasks/tasks.json.
 */

import fs from "fs/promises"
import crypto from "crypto"
import { getTasksFilePath, getTasksDir } from "./paths.js"
import { acquireLock } from "./lock.js"
import type { Task, TaskStatus } from "./types.js"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readTasksFile(teamName: string): Promise<Task[]> {
  try {
    const raw = await fs.readFile(getTasksFilePath(teamName), "utf-8")
    return JSON.parse(raw) as Task[]
  } catch {
    return []
  }
}

async function writeTasksFile(teamName: string, tasks: Task[]): Promise<void> {
  const dir = getTasksDir(teamName)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(getTasksFilePath(teamName), JSON.stringify(tasks, null, 2), "utf-8")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new task on the team's task board.
 */
export async function createTask(
  teamName: string,
  task: Omit<Task, "id" | "createdAt" | "updatedAt">,
): Promise<Task> {
  // Ensure the tasks directory exists before acquiring the lock
  await fs.mkdir(getTasksDir(teamName), { recursive: true })
  const lockPath = `${getTasksFilePath(teamName)}.lock`
  const release = await acquireLock(lockPath)

  try {
    const tasks = await readTasksFile(teamName)
    const now = Date.now()

    const newTask: Task = {
      ...task,
      id: crypto.randomUUID().slice(0, 8),
      blocks: task.blocks ?? [],
      blockedBy: task.blockedBy ?? [],
      createdAt: now,
      updatedAt: now,
    }

    tasks.push(newTask)
    await writeTasksFile(teamName, tasks)
    return newTask
  } finally {
    await release()
  }
}

/**
 * Get a task by ID.
 */
export async function getTask(teamName: string, taskId: string): Promise<Task | null> {
  const tasks = await readTasksFile(teamName)
  return tasks.find((t) => t.id === taskId) ?? null
}

/**
 * Update a task's fields.
 */
export async function updateTask(
  teamName: string,
  taskId: string,
  updates: Partial<Omit<Task, "id" | "createdAt">>,
): Promise<Task | null> {
  await fs.mkdir(getTasksDir(teamName), { recursive: true })
  const lockPath = `${getTasksFilePath(teamName)}.lock`
  const release = await acquireLock(lockPath)

  try {
    const tasks = await readTasksFile(teamName)
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return null

    Object.assign(task, updates, { updatedAt: Date.now() })

    // Normalize common status aliases
    if (task.status) {
      const statusMap: Record<string, string> = {
        complete: "completed",
        done: "completed",
        finished: "completed",
        "in-progress": "in_progress",
        running: "in_progress",
        active: "in_progress",
        blocked: "pending",
        waiting: "pending",
        removed: "deleted",
        cancelled: "deleted",
        canceled: "deleted",
      }
      task.status = (statusMap[task.status] ?? task.status) as Task["status"]
    }

    // Handle additive block lists
    if (updates.blocks) {
      task.blocks = [...new Set([...task.blocks, ...updates.blocks])]
    }
    if (updates.blockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...updates.blockedBy])]
    }

    await writeTasksFile(teamName, tasks)
    return task
  } finally {
    await release()
  }
}

/**
 * Delete a task by ID.
 */
export async function deleteTask(teamName: string, taskId: string): Promise<boolean> {
  await fs.mkdir(getTasksDir(teamName), { recursive: true })
  const lockPath = `${getTasksFilePath(teamName)}.lock`
  const release = await acquireLock(lockPath)

  try {
    const tasks = await readTasksFile(teamName)
    const before = tasks.length
    const filtered = tasks.filter((t) => t.id !== taskId)

    if (filtered.length < before) {
      await writeTasksFile(teamName, filtered)
      return true
    }
    return false
  } finally {
    await release()
  }
}

/**
 * List all tasks for a team.
 */
export async function listTasks(teamName: string): Promise<Task[]> {
  return readTasksFile(teamName)
}

/**
 * Add a blocking relationship.
 */
export async function blockTask(
  teamName: string,
  taskId: string,
  blockedById: string,
): Promise<void> {
  await updateTask(teamName, taskId, { blockedBy: [blockedById] })
}

/**
 * Reset the task list (create empty tasks.json).
 */
export async function resetTaskList(teamName: string): Promise<void> {
  await writeTasksFile(teamName, [])
}
