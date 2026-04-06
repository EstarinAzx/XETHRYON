import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import path from "path"
import fs from "fs"

type TaskInfo = {
  id: string
  subject: string
  status: string
  owner?: string
  blockedBy: string[]
}

type TeamConfig = {
  name: string
  description?: string
  createdAt?: number
  members: Array<{
    name: string
    agentId: string
    isActive: boolean
    agentType?: string
  }>
}

type TeamEntry = { name: string; config: TeamConfig; tasks: TaskInfo[] }

/**
 * Read swarm state directly from filesystem.
 * This avoids module isolation issues between TUI and server.
 */
function readSwarmFromDisk(): {
  teamName: string | null
  teams: TeamEntry[]
} {
  // Check env first (set by server-side setActiveTeam)
  const activeTeam = process.env.XETHRYON_ACTIVE_TEAM ?? null

  const swarmRoot = path.join(process.cwd(), ".opencode", "swarm")
  if (!fs.existsSync(swarmRoot)) {
    return { teamName: activeTeam, teams: [] }
  }

  const teams: TeamEntry[] = []

  try {
    const entries = fs.readdirSync(swarmRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const teamDir = path.join(swarmRoot, entry.name)
      const configPath = path.join(teamDir, "config.json")
      const tasksPath = path.join(teamDir, "tasks", "tasks.json")

      let config: TeamConfig | null = null
      let tasks: TaskInfo[] = []

      try {
        if (fs.existsSync(configPath)) {
          config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
        }
      } catch {}

      try {
        if (fs.existsSync(tasksPath)) {
          tasks = JSON.parse(fs.readFileSync(tasksPath, "utf-8"))
        }
      } catch {}

      if (config) {
        teams.push({ name: config.name, config, tasks })
      }
    }
  } catch {}

  // Sort by createdAt descending — most recent first
  teams.sort((a, b) => (b.config.createdAt ?? 0) - (a.config.createdAt ?? 0))

  return { teamName: activeTeam, teams }
}

export function DialogSwarm() {
  const { theme } = useTheme()
  const dialog = useDialog()

  const [teamName, setTeamName] = createSignal<string | null>(null)
  const [members, setMembers] = createSignal<TeamConfig["members"]>([])
  const [tasks, setTasks] = createSignal<TaskInfo[]>([])
  const [elapsed, setElapsed] = createSignal(0)
  const [teamIndex, setTeamIndex] = createSignal(0)
  const [teamCount, setTeamCount] = createSignal(0)

  const startTime = Date.now()

  // Poll swarm state from filesystem
  const poll = () => {
    try {
      const state = readSwarmFromDisk()
      setTeamCount(state.teams.length)

      // Clamp index if teams were deleted
      const idx = Math.min(teamIndex(), Math.max(0, state.teams.length - 1))
      setTeamIndex(idx)

      const active = state.teams[idx]

      if (active) {
        setTeamName(active.name)
        setMembers(active.config.members)
        setTasks(active.tasks)
      } else {
        setTeamName(null)
        setMembers([])
        setTasks([])
      }

      setElapsed(Math.round((Date.now() - startTime) / 1000))
    } catch {
      // silently retry next cycle
    }
  }

  // Keyboard: ←/→ to cycle teams
  useKeyboard((evt) => {
    if (evt.name === "left" || evt.name === "h") {
      setTeamIndex((i) => Math.max(0, i - 1))
      poll() // refresh immediately
    } else if (evt.name === "right" || evt.name === "l") {
      setTeamIndex((i) => Math.min(teamCount() - 1, i + 1))
      poll()
    }
  })

  // Initial poll + interval
  poll()
  const timer = setInterval(poll, 1000)
  onCleanup(() => clearInterval(timer))

  const statusIcon = (status: string) => {
    switch (status) {
      case "running":
      case "in_progress":
        return "◉"
      case "idle":
      case "pending":
        return "○"
      case "completed":
        return "✓"
      case "stopped":
      case "deleted":
        return "✗"
      default:
        return "?"
    }
  }

  const statusColor = (status: string) => {
    switch (status) {
      case "running":
      case "in_progress":
        return theme.success
      case "idle":
      case "pending":
        return theme.warning
      case "completed":
        return theme.primary
      case "stopped":
      case "deleted":
        return theme.error
      default:
        return theme.textMuted
    }
  }

  const activeTasks = () => tasks().filter((t) => t.status !== "deleted")
  const completedCount = () => activeTasks().filter((t) => t.status === "completed").length
  const totalCount = () => activeTasks().length

  // Resolve blockedBy IDs to task subjects
  const resolveBlockedBy = (blockedBy: string[]) => {
    return blockedBy.map((id) => {
      const dep = tasks().find((t) => t.id === id)
      return dep ? dep.subject : id
    })
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      {/* Header */}
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            ◈ Swarm Dashboard
          </text>
          <Show when={teamCount() > 1}>
            <text fg={theme.textMuted}>
              ({teamIndex() + 1}/{teamCount()})
            </text>
          </Show>
        </box>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <Show
        when={teamName()}
        fallback={
          <box gap={1}>
            <text fg={theme.textMuted}>No active swarm team.</text>
            <text fg={theme.textMuted}>
              Use COORDINATE mode to create a team with team_create.
            </text>
          </box>
        }
      >
        {/* Team name */}
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>Team:</text>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {teamName()!}
          </text>
          <text fg={theme.textMuted}>
            ({elapsed()}s)
          </text>
        </box>

        {/* Agents section */}
        <box>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Agents
          </text>
          <Show
            when={members().length > 0}
            fallback={<text fg={theme.textMuted}>  No agents registered</text>}
          >
            <For each={members()}>
              {(member) => {
                // Derive status from task board — if agent owns an in_progress task, they're active
                const isWorking = () => tasks().some(
                  (t) => t.owner === member.name && t.status === "in_progress"
                )
                const hasCompleted = () => tasks().some(
                  (t) => t.owner === member.name && t.status === "completed"
                )
                const label = () => isWorking() ? "active" : hasCompleted() ? "done" : "idle"
                const color = () => isWorking() ? theme.success : hasCompleted() ? theme.primary : theme.textMuted
                const icon = () => isWorking() ? "◉" : hasCompleted() ? "✓" : "○"

                return (
                  <box flexDirection="row" gap={1}>
                    <text fg={color()} flexShrink={0}>
                      {icon()}
                    </text>
                    <text fg={theme.text} wrapMode="word">
                      <b>{member.name}</b>{" "}
                      <span style={{ fg: theme.textMuted }}>
                        {label()}
                      </span>
                    </text>
                  </box>
                )
              }}
            </For>
          </Show>
        </box>

        {/* Tasks section */}
        <box>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Tasks
            </text>
            <Show when={totalCount() > 0}>
              <text fg={theme.textMuted}>
                {completedCount()}/{totalCount()}
              </text>
            </Show>
          </box>
          <Show
            when={tasks().length > 0}
            fallback={<text fg={theme.textMuted}>  No tasks on board</text>}
          >
            <For each={tasks()}>
              {(task) => (
                <box>
                  <box flexDirection="row" gap={1}>
                    <text fg={statusColor(task.status)} flexShrink={0}>
                      {statusIcon(task.status)}
                    </text>
                    <text fg={theme.text} wrapMode="word">
                      <b>{task.subject}</b>{" "}
                      <span style={{ fg: theme.textMuted }}>
                        ({task.status}
                        {task.owner ? ` → ${task.owner}` : ""})
                      </span>
                    </text>
                  </box>
                  <Show when={task.blockedBy.length > 0}>
                    <text fg={theme.warning} paddingLeft={3}>
                      └─ blocked by: {resolveBlockedBy(task.blockedBy).join(", ")}
                    </text>
                  </Show>
                </box>
              )}
            </For>
          </Show>
        </box>

        {/* Progress bar */}
        <Show when={totalCount() > 0}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted}>Progress:</text>
            <text fg={theme.primary}>
              {"█".repeat(Math.round((completedCount() / totalCount()) * 20))}
              {"░".repeat(20 - Math.round((completedCount() / totalCount()) * 20))}
            </text>
            <text fg={theme.text}>
              {Math.round((completedCount() / totalCount()) * 100)}%
            </text>
          </box>
        </Show>

        {/* Navigation hint */}
        <Show when={teamCount() > 1}>
          <box flexDirection="row" justifyContent="center" gap={1}>
            <text fg={theme.textMuted}>
              ← → cycle teams
            </text>
          </box>
        </Show>
      </Show>
    </box>
  )
}
