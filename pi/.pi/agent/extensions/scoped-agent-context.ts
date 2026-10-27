/** Read inherited instructions from the primary checkout, never a shared owner bucket. */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ContextFile = { path: string; content: string };
export type CheckoutIdentity = { root: string; primary: string };
const NAMES = ["AGENTS.md", "CLAUDE.md"];

function canonical(path: string): string {
	try { return realpathSync(path); } catch { return resolve(path); }
}
function inside(path: string, directory: string): boolean {
	const suffix = relative(canonical(directory), canonical(path));
	return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}
function gitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
	return env;
}
function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024,
		env: gitEnvironment(),
	});
	if (result.error || result.status !== 0) throw new Error("Cannot validate checkout identity with Git.");
	return result.stdout.trim();
}

/** Git metadata is authoritative, including custom layouts and calls from nested folders. */
export function resolveCheckout(cwd: string): CheckoutIdentity | undefined {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], {
		encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024,
		env: gitEnvironment(),
	});
	if (result.error) throw new Error("Checkout identity check timed out or failed to start.");
	if (result.status !== 0) {
		if (/not a git repository/i.test(result.stderr)) return undefined;
		throw new Error("Cannot resolve checkout identity with Git.");
	}
	const paths = result.stdout.trim().split("\n");
	const [root, common] = paths;
	if (paths.length !== 2 || !root || !common || !isAbsolute(root) || !isAbsolute(common)) throw new Error("Invalid checkout identity from Git.");
	const listing = git(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0");
	const first = listing.find((line) => line.startsWith("worktree "));
	if (!first || listing.slice(0, listing.indexOf("")).includes("bare")) throw new Error("No primary working checkout is available.");
	const primary = first.slice("worktree ".length);
	if (!isAbsolute(primary)) throw new Error("Invalid primary checkout path.");
	const primaryPaths = git(primary, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"]).split("\n");
	if (primaryPaths.length !== 2 || canonical(primaryPaths[0]) !== canonical(primary)
		|| canonical(primaryPaths[1]) !== canonical(common)) throw new Error("Primary checkout belongs to another repository.");
	return { root: canonical(root), primary: canonical(primary) };
}

/** Recognize only the two known old HelloFresh link targets. Never unlink anything. */
export function isLegacyOwnerLink(path: string, root: string | undefined, home = homedir()): boolean {
	const lexical = resolve(path), worktrees = resolve(home, "worktrees");
	const owner = dirname(lexical);
	if (dirname(owner) !== worktrees || !NAMES.includes(lexical.slice(owner.length + 1))) return false;
	if (root && inside(dirname(lexical), root)) return false;
	try {
		if (!lstatSync(lexical).isSymbolicLink()) return false;
		const target = resolve(owner, readlinkSync(lexical));
		const name = lexical.slice(owner.length + 1);
		return target === resolve(home, "projects", "hellofresh", name)
			|| target === resolve(home, "dotfiles", "hellofresh", "projects", "hellofresh", name);
	} catch { return false; }
}

export function scopeContext(
	files: ContextFile[], identity: CheckoutIdentity | undefined, cwd: string, agentDir: string, home = homedir(),
): ContextFile[] {
	const kept = files.filter((file) => !isLegacyOwnerLink(file.path, identity?.root, home));
	if (!identity || identity.root === identity.primary) return kept;
	const cwdAncestors = new Set<string>();
	for (let dir = canonical(cwd);;) {
		cwdAncestors.add(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const existingPaths = new Set(kept.map((file) => canonical(file.path)));
	const primaryParent = dirname(identity.primary);
	const inherited = loadProjectContextFiles({ cwd: primaryParent, agentDir }).filter((file) => {
		const directory = canonical(dirname(file.path));
		return directory !== canonical(agentDir) && !cwdAncestors.has(directory)
			&& inside(primaryParent, directory) && !existingPaths.has(canonical(file.path));
	});
	if (!inherited.length) return kept;
	const index = kept.findIndex((file) => inside(dirname(file.path), identity.root));
	return [...kept.slice(0, index < 0 ? kept.length : index), ...inherited, ...kept.slice(index < 0 ? kept.length : index)];
}

/** Cheap identity invalidation after worktree repair, relocation, or repository creation. */
export function checkoutRevision(cwd: string, identity?: CheckoutIdentity): string {
	const parts: string[] = [];
	for (let dir = canonical(cwd);;) {
		const marker = join(dir, ".git");
		try {
			const stat = lstatSync(marker);
			parts.push(marker, `${stat.dev}:${stat.ino}:${stat.mode}`);
			if (stat.isFile()) {
				const pointer = readFileSync(marker, "utf8");
				parts.push(pointer);
				const match = /^gitdir:\s*(.+)$/m.exec(pointer);
				if (match) {
					const gitDir = resolve(dir, match[1].trim());
					for (const name of ["commondir", "gitdir"]) {
						try { parts.push(readFileSync(join(gitDir, name), "utf8")); }
						catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") parts.push("missing"); else throw error; }
					}
				}
			}
			if (stat.isSymbolicLink()) parts.push(readlinkSync(marker));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (identity) {
		parts.push(canonical(identity.root), canonical(identity.primary));
		try {
			const marker = join(identity.primary, ".git");
			const stat = lstatSync(marker);
			parts.push(`${stat.dev}:${stat.ino}:${stat.mode}`);
			if (stat.isFile()) parts.push(readFileSync(marker, "utf8"));
			if (stat.isSymbolicLink()) parts.push(readlinkSync(marker));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			parts.push("primary-missing");
		}
	}
	return parts.join("\0");
}

export default function scopedAgentContext(pi: ExtensionAPI) {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	let identity: CheckoutIdentity | undefined;
	let resolvedCwd: string | undefined;
	let revision: string | undefined;
	const clear = () => { resolvedCwd = undefined; identity = undefined; revision = undefined; };
	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);
	pi.on("before_agent_start", (event, ctx) => {
		// Native CLI opt-outs and explicit empty SDK context both supply an empty list.
		if (!event.systemPromptOptions.contextFiles.length) return;
		try {
			if (resolvedCwd !== ctx.cwd || revision !== checkoutRevision(ctx.cwd, identity)) {
				identity = resolveCheckout(ctx.cwd);
				resolvedCwd = ctx.cwd;
				revision = checkoutRevision(ctx.cwd, identity);
			}
			event.systemPromptOptions.contextFiles = scopeContext(event.systemPromptOptions.contextFiles, identity, ctx.cwd, agentDir);
		} catch (error) {
			// Pi reports hook exceptions but continues. Abort explicitly to fail closed.
			ctx.abort();
			throw new Error(`Scoped instructions unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
