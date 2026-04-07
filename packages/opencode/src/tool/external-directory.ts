import path from "path"
import type { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Filesystem } from "@/util/filesystem"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  if (!target) return

  if (options?.bypass) return

  // When autonomy is enabled, auto-approve all external directory access.
  // Full autonomy = no human intervention, including directory approvals.
  if (process.env.XETHRYON_AUTONOMY === "1") return

  const full = process.platform === "win32" ? Filesystem.normalizePath(target) : target
  if (Instance.containsPath(full)) return

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? Filesystem.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
}
