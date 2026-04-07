/**
 * Xethryon Swarm / Teams Infrastructure — barrel exports.
 */

// Constants
export * from "./constants.js"

// Types
export type {
  TeamFile,
  TeamMember,
  TeammateMessage,
  TypedMessage,
  Task,
  TaskStatus,
  TaskResult,
  FailureKind,
  TeammateSpawnConfig,
  SpawnResult,
  ActiveTeammate,
  TeammateStatus,
} from "./types.js"

// Identity
export {
  sanitizeName,
  sanitizeAgentName,
  formatAgentId,
  parseAgentId,
  setTeamContext,
  getTeamContext,
  clearTeamContext,
  isTeamActive,
  isTeamLead,
} from "./identity.js"

// Paths
export {
  getSwarmRoot,
  getTeamDir,
  getTeamFilePath,
  getInboxDir,
  getInboxPath,
  getTasksDir,
  getTasksFilePath,
} from "./paths.js"

// Lock
export { acquireLock, releaseLock } from "./lock.js"

// Team CRUD
export {
  readTeamFile,
  readTeamFileAsync,
  writeTeamFileAsync,
  addMemberToTeam,
  removeMemberFromTeam,
  setMemberActive,
  cleanupTeamDirectories,
  generateUniqueTeamName,
  listTeams,
} from "./team.js"

// Mailbox
export {
  readMailbox,
  readUnreadMessages,
  writeToMailbox,
  markMessagesAsRead,
  clearMailbox,
  formatTeammateMessages,
  createIdleNotification,
  createShutdownRequestMessage,
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  isIdleNotification,
  isShutdownRequest,
  isShutdownApproved,
  isShutdownRejected,
  isTaskAssignment,
} from "./mailbox.js"

// Task board
export {
  createTask,
  getTask,
  updateTask,
  deleteTask,
  listTasks,
  blockTask,
  resetTaskList,
  verifyTask,
} from "./tasks-board.js"

// State
export {
  setActiveTeam,
  getActiveTeam,
  clearActiveTeam,
  setCoordinatorSessionId,
  getCoordinatorSessionId,
  clearCoordinatorSessionId,
  registerTeammate,
  unregisterTeammate,
  getTeammate,
  getAllTeammates,
  getTeammatesForTeam,
  updateTeammateStatus,
  abortTeammate,
  abortAllTeammates,
  cleanupAllTeammates,
} from "./state.js"

// Spawn
export {
  spawnTeammate,
  stopTeammate,
  isTeammateRunning,
} from "./spawn.js"

// Events
export type { SwarmTaskEvent } from "./events.js"
export { emitTaskDone, onTaskDone } from "./events.js"
