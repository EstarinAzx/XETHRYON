/**
 * Swarm type definitions.
 * Ported from cc-leak: swarm/backends/types.ts + teammateMailbox.ts types.
 *
 * Stripped: PermissionRequest/Response, SandboxPermission, PlanApproval
 * (pane-only message types not needed for in-process backend).
 */

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export interface TeamFile {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  members: TeamMember[]
}

export interface TeamMember {
  agentId: string
  name: string
  agentType?: string
  model?: string
  prompt?: string
  color?: string
  joinedAt: number
  cwd: string
  sessionId?: string
  isActive?: boolean
  backendType: "in-process"
  worktreeDir?: string
  worktreeBranch?: string
  workspaceId?: string
}

// ---------------------------------------------------------------------------
// Mailbox messages
// ---------------------------------------------------------------------------

export interface TeammateMessage {
  from: string
  text: string // JSON string containing a typed message (or plain text)
  timestamp: number
  read: boolean
  color?: string
  summary?: string
}

/** Discriminated message types (parsed from `text` field) */

export interface IdleNotificationMessage {
  type: "idle_notification"
  from: string
  idleReason?: string
  completedTaskId?: string
}

export interface ShutdownRequestMessage {
  type: "shutdown_request"
  requestId: string
  from: string
  reason?: string
}

export interface ShutdownApprovedMessage {
  type: "shutdown_approved"
  requestId: string
  from: string
}

export interface ShutdownRejectedMessage {
  type: "shutdown_rejected"
  requestId: string
  from: string
  reason: string
}

export interface TaskAssignmentMessage {
  type: "task_assignment"
  taskId: string
  subject: string
  description: string
  assignedBy: string
}

export type TypedMessage =
  | IdleNotificationMessage
  | ShutdownRequestMessage
  | ShutdownApprovedMessage
  | ShutdownRejectedMessage
  | TaskAssignmentMessage

// ---------------------------------------------------------------------------
// Task board
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"     // Not started, no blockers (or blockers not yet evaluated)
  | "blocked"     // Explicitly blocked — waiting on deps
  | "in_progress" // Agent is running
  | "verifying"   // Agent finished, outputs being checked
  | "completed"   // Verified — outputs exist, criteria met
  | "failed"      // Verification failed or agent errored
  | "deleted"     // Removed

/** Failure classification for retry logic */
export type FailureKind = "transient" | "deterministic"

/** Structured result from an agent's execution */
export interface TaskResult {
  status: "success" | "failure"
  wrote: string[]       // Files created/modified
  read: string[]        // Files read
  notes: string[]       // Agent's observations
  failureKind?: FailureKind
  error?: string
}

export interface Task {
  id: string
  subject: string
  description: string
  status: TaskStatus
  owner?: string
  blocks: string[]
  blockedBy: string[]

  // v2: Artifact-based completion
  outputs?: string[]             // Expected output file paths (absolute)
  successCriteria?: string[]     // Validation rules, e.g. "file_exists:/path/to/file"
  result?: TaskResult            // Structured agent output

  // v2: Watchdog
  timeout?: number               // Per-task timeout in seconds (default: 60)
  retryCount?: number            // How many times this task has been retried

  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export interface TeammateSpawnConfig {
  name: string
  teamName: string
  prompt: string
  agentType?: string
  model?: string
  description?: string
  color?: string
}

export interface SpawnResult {
  success: boolean
  agentId: string
  sessionId: string
  error?: string
}

export type TeammateStatus = "running" | "idle" | "stopped"

export interface ActiveTeammate {
  agentId: string
  name: string
  teamName: string
  sessionId: string
  abortController: AbortController
  status: TeammateStatus
  worktreeDir?: string
  worktreeBranch?: string
  workspaceId?: string
}
