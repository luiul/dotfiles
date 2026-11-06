import { detectProject } from "../project.js";
import { loadConfig } from "../config.js";

/** Narrow defaults are relevance controls, not an access-control boundary. */
export function resolveSearchScope(args: { project?: string | null; scope?: "current" | "global" | "all" }, cwd: string, memory = false, target?: string) {
  if (args.scope && args.scope !== "current" && args.project !== undefined) throw new Error("Use either scope or a project filter, not both.");
  if (args.scope === "all") return {};
  if (args.scope === "global" && memory) return { project: null };
  if (args.project !== undefined) return { project: args.project };
  const project = detectProject(loadConfig().projectsMemoryDir, cwd).name;
  if (memory) {
    if (target === "user") return { project: null };
    return { project, includeGlobal: target !== "project" };
  }
  if (!project) throw new Error("No current project. Set project or scope=all explicitly.");
  return { project };
}

/** The legacy index uses cwd basenames. Resolve stored cwd instead of trusting that label. */
export function resolveSessionSearchScope(args: { project?: string; scope?: "current" | "all" }, cwd: string, db: { getDb(): any }) {
  const scope = resolveSearchScope(args, cwd);
  if (args.project !== undefined || args.scope === "all") return scope;
  const rows = db.getDb().prepare("SELECT id, cwd FROM sessions").all() as Array<{ id: string; cwd: string }>;
  const projectsMemoryDir = loadConfig().projectsMemoryDir;
  return { sessionIds: rows.filter(row => detectProject(projectsMemoryDir, row.cwd).name === scope.project).map(row => row.id) };
}
