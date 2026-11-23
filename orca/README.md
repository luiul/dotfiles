# Orca

Stably's Orca (https://onorca.dev), installed as a Homebrew cask (`stablyai/orca/orca`, added to `brew/Brewfile`). It runs CLI agents side-by-side, each in its own git worktree, and has first-class pi integration (auto-detect, live status via a per-PTY extension overlay — it never touches `~/.pi/agent/settings.json` — structured native chat, session resume, background helper rows).

## Paths

- `~/.orca` — worktrees and agent state (Orca-managed, native worktree lifecycle)
- `~/Library/Application Support/orca/profiles/local-default/profile-state.db` — live SQLite settings store (domain `settings`); `orca-data.json` only survives as a legacy export/migration artifact. Settings have no write CLI; drive the Settings UI via `orca computer` commands (Accessibility + Screenshots permission for the "Orca Computer Use" helper required once)
- `~/Library/Caches/com.stablyai.orca*` — caches

## Worktree ownership

Creation and removal of worktrees are owned by worktrunk (`wt`) and coppice (`cop`), including for repos registered in Orca. Orca is the watching and agent layer: it auto-discovers wt-created worktrees of a registered repo and runs pi terminals in them. Verified with a live throwaway-repo test (2026-10-25): `cop list` flags an Orca-native worktree as mismatched, `cop relocate` would move it away from Orca's registry path, and `cop clean` can sweep it.

- Never use Orca's native flow (`orca worktree create`, New Workspace in the UI) on repos registered in wt. Orca-native worktrees land under `~/orca/workspaces` (off wt's path template), skip every wt hook (venv symlink, copy-ignored, AGENTS.md links, registry, default-branch freshen), and become destructive interference for `cop relocate` and `cop clean`.
- Remove worktrees through `wt remove` / `cop remove` only. Orca's delete on a wt-created worktree skips wt's protected-branch guard and the parent-dir prune hook.
- Register a repo for watching with `orca repo add --path <main checkout>`, then `orca repo set --repo path:<main checkout> --external-worktree-visibility show`. The global default stays `hide`, so throwaway test repos stay out of the sidebar; per-repo `show` marks the wt-managed ones (dotfiles and canopy today).
- Orca's own worktree flow remains fine for throwaway test repos that are never registered in wt.

## Watch a repo from the terminal

`orca-watch` (alias `owa`) registers the main checkout and shows its external worktrees. It does not create worktrees, launch agents, or change your directory. Orca must be running. The helper needs `git`, `orca`, and `jq`.

```zsh
# Pass a repo path from anywhere.
owa ~/projects/personal/canopy
orca-watch "/path/to/my repo"

# Omit the path inside a repo, subdirectory, or linked worktree.
owa

# Relative paths work too.
owa ../canopy
```

Both names complete directory paths with Tab. Linked worktrees resolve to the main checkout. Repeated calls keep the same repo registered and set its external worktree visibility to `show`. An invalid path or an Orca error stops the command without a success message. If registration succeeds but setting visibility fails, the repo stays registered. Run the command again after fixing the error.

The function lives in `zsh/.zsh_config/funcs_orca.zsh`. Completion lives in `zsh/.zfunc/_orca-watch`. Run `zsh -f scripts/test-orca-watch.zsh` to check path handling and failure cases without changing your Orca registrations.

The [Coppice workflow](https://github.com/luiul/coppice) combines watching, worktree creation or reuse, setup, and Pi launch in one command: `cop orca [repo]`. It uses wt for creation, then opens the verified Pi terminal in Orca. `cop new` remains worktree-only, even in a watched repo. Both commands accept `--branch`, `--base`, and `--yes`. Retry or reopen with `cop orca /path/to/repo --branch branch-name --yes`. Shell integration enters the resulting worktree. Direct wt, agent-marked, piped, and Herdr calls do not start this workflow. The watch helper remains available but is no longer a required first step. Opening Pi's terminal binds its PTY to sidebar state, so Hide sleeping keeps the worktree visible even when Pi is idle.

Before deleting a disposable registered repo, close its terminal tabs with `orca terminal close --worktree path:<checkout> --all --json`. Removing its project setup can leave terminal tabs and resume records behind. If the repo is already gone, find the exact stale handle in `orca terminal list --json` and close only that tab with `orca terminal close --terminal <handle> --tab --json`.

## Coordinate a task with `/orca`

Start from a manual shell with `cop orca [repo] -b <branch>`, then give the Pi session `/orca <task>`. Coppice owns watching, wt setup, and safe Pi launch or reuse. The prompt makes that Pi session the coordinator. It brings Orca worker results back to the same chat rather than launching a second coordinator.

When ownership is unknown, use the research repo for the coordinator:

```sh
cop orca ~/projects/hellofresh/research -b investigate-writeback
```

Then ask for the outcome:

```text
/orca Investigate these alerts, prepare approved Jira intake, and coordinate the appropriate fix: [paste alerts]
```

Pi joins unquoted template arguments with spaces. For logs or code whose layout matters, invoke `/orca` with no arguments, then paste the task and evidence when it asks. Alternatively quote the complete multiline request. The command has no flags, so option-like text inside the request is task content.

For a known HelloFresh ticket and repo, use the required ticket branch instead:

```sh
cop orca ~/projects/hellofresh/isa-orchestration -b patch/GLOA-123-fix-writeback
```

```text
/orca Plan and implement the approved scope in https://hellofresh.atlassian.net/browse/GLOA-123
```

The prompt supports any task expressed as a specialized request. These words describe the desired outcome, not parser modes, flags, native Orca commands, or permission levels. You do not need to choose one word before giving a clear request. The numbers below are for reference, not command syntax. See [specialized requests](#specialized-requests) for outputs, limits, and examples.

It uses the installed [Orca orchestration guide](https://github.com/stablyai/orca/blob/main/skill-guides/orchestration/SKILL.md), starts with a small worker split, and preserves human approval gates. Discovery stays read-only. Planning does not permit edits. A request to coordinate a fix does not approve commits, publication, production changes, reruns, or backfills. No code change can be the correct result.

Workers use verified existing Orca workspaces. Additional checkouts belong to wt or `cop new`, not Orca's native worktree flow. The coordinator must verify setup before dispatch. Agents do not call the interactive `cop orca` entry point. A Run tracks tasks and mail; the coordinator still dispatches ready tasks and handles worker reports. It ends its turn to let Orca wake it rather than polling.

HelloFresh ticket creation stays in a fresh Pi session at exactly `~/projects/hellofresh`, with trusted central settings and memory workers disabled. Intake uses `create-hellofresh-ticket` and Harvest, not native Orca Jira writes. The coordinator delegates that stage only when the exact folder workspace and fresh launch can be verified. Otherwise it returns a manual intake handoff and pauses ticket-dependent work. The fixing session is separate and starts in the confirmed repo after ticket and plan approval.

The command is a Markdown prompt template in `pi/.pi/agent/prompts/orca.md`, like `/proofread`. It guides the agent but does not enforce a permission or security boundary. It does not enable orchestration, change Orca settings, or run a service. If Orca is unavailable or orchestration is disabled, the agent reports the blocker instead of using Pi subagents as a hidden fallback. Run `/reload` in an existing Pi session after deployment.

Verify prompt discovery, argument expansion, and instruction contracts:

```sh
node scripts/test-orca-prompt.mjs
PATH="/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS:$PATH" node scripts/test-orca-prompt-live.mjs
```

The live check uses a private Rex terminal and a local provider fixture. It proves command discovery and expansion, not model compliance, real worker coordination, Jira access, or production recovery. Add `--live` after deployment to check auto-discovery from the real Pi agent directory without an explicit prompt override. Lifecycle assertions are instruction-contract checks. A real Orca wakeup and recovery fixture is separate, opt-in work with a deadline and explicit cleanup, not part of these deterministic tests.

## Specialized requests

Ask for the result you need. Include the target, relevant evidence or links, constraints, and what would count as success. Explicitly say when to stop. Workers receive bounded briefs, not a general invitation to change everything.

### Core requests

| # | Request | Use it to ask | Expected result and limits |
| --- | --- | --- | --- |
| 1 | **Discover** | What exists, where does it live, and who owns it? | A checked map of repos, systems, dependencies, and gaps. Read-only, no inferred implementation repo. |
| 2 | **Research** | Which options fit this problem? | Sources, tradeoffs, unknowns, and a recommendation. Compare versions and constraints. Do not send private evidence to public search. |
| 3 | **Diagnose** | Why does this fail? | Reproduction or technical evidence, cause or remaining uncertainty, and recovery options. Use read-only evidence or safe local reproduction. Production reruns and changes need separate approval. |
| 4 | **Design** | How should the solution behave? | Behavior, contracts, alternatives, risks, and rollback needs. A proposal, not code or shared-data changes. |
| 5 | **Plan** | What work should happen, in which order? | Small tasks with acceptance criteria, dependencies, and verification. No edits. A plan can use an existing approved tracker; new tracker writes retain their approval gate. |
| 6 | **Implement** | Make this approved change. | The smallest reviewable diff, relevant tests, and remaining gaps. Respect approved scope and leave changes unstaged. No automatic commit, publication, or deployment. |
| 7 | **Review** | What is wrong or risky in this artifact? | Prioritized findings with paths, evidence, and requirement impact. Read-only unless fixes are also requested and approved. Another agent's approval is not proof of correctness. |
| 8 | **Verify** | Does this meet the requirements? | Executed checks, observed results, failures, and unverified criteria. Distinguish local, mocked, sampled, and approved live evidence. Running a check does not authorize production mutation. |
| 9 | **Explain** | Help me understand this system or decision. | A clear explanation grounded in checked code, docs, or data. Separate facts from assumptions. No changes unless requested. |

Discover maps the actual environment. Research compares evidence and options. Design chooses behavior and contracts. Plan turns that choice into work. Review looks for defects. Verify tests stated requirements. Combine them when the requested outcome needs several stages, but do not treat every request as a full pipeline.

### More focused requests

| Request | Expected result | State these constraints |
| --- | --- | --- |
| **Audit** | Findings against named security, access, compatibility, or policy criteria. | Exact scope and threat or contract model. Prefer read-only checks. No broad claim that a system is safe from a narrow sample. |
| **Benchmark** | Comparable baseline and candidate measurements. | Workload, inputs, environment, metric, budget, and allowed execution. Report variance and limits. Do not make speed claims without measurements. |
| **Refactor** | Simpler structure with preserved behavior. | The contract that must not change, test baseline, and permitted files. Treat behavior changes as a separate decision. |
| **Migrate** | A compatibility plan or an approved migration change. | State which you want. Define preserved keys, values, types, metadata, consumers, rollout gates, and rollback. Do not change shared data silently. |
| **Document** | Checked code-adjacent docs or a chat explanation. | Audience, target, and evidence. Plans and trackers belong in the project's tracker. Scratch files remain opt-in. |
| **Summarize** | Concise checked findings, decisions, and gaps. | Source scope and intended audience. Do not turn historical reports into current facts without checking. |
| **Hand off** | Context another session can act on. | Exact checkout, task and tracker links, approvals, checks, blockers, and next action. An explicit handoff does not prove the receiving worker accepted ownership. |

### Copyable examples

Each line is a request, not an enforced mode switch. Use the same command for any repo after the manual `cop orca` entry point.

```text
/orca Discover the repos and owners for this export. Read-only. Return the evidence and gaps.
/orca Research these two options using official sources. Compare them against our constraints and recommend one.
/orca Diagnose these alerts. Do not rerun jobs or change accounts. Stop with checked evidence and recovery options.
/orca Design the retry behavior. Preserve the existing consumer contract and compare rollback options. No edits.
/orca Plan the migration, then wait for my review. Include acceptance criteria and verification for each task.
/orca Implement the approved scope in this ticket. Preserve the stated contract, run relevant checks, and leave changes unstaged.
/orca Review this diff for correctness, compatibility, and failure paths. Report findings, do not fix them yet.
/orca Verify the approved criteria with local checks first. Ask before any production-changing check.
/orca Explain how this data reaches the consumer. Check the relevant code and separate facts from assumptions.
/orca Audit this component's credential handling. Read-only, no network calls or installation.
/orca Benchmark the approved candidate against the baseline using the same bounded fixture. Report measurements and variance.
/orca Refactor the approved module without changing its public behavior. Keep the existing tests and add focused coverage.
/orca Plan a migration of this schema, including compatibility and rollback. Do not migrate data yet.
/orca Document the approved behavior in the code-adjacent README. Check the examples against the actual API.
/orca Summarize the findings from this session and prepare an implementation handoff. Do not start a new worker.
```

For several stages, name both the outcome and the stop point:

```text
/orca Discover ownership and plan the correction, then wait. Do not implement or create a ticket yet.
/orca Review and fix the issues within the approved scope, then verify. Leave the changes unstaged for my review.
/orca Diagnose, prepare approved central Jira intake, then coordinate the approved fix. Pause at the existing approval gates.
```

Ticket creation, commits, publication, deployment, production reruns, backfills, and cleanup remain separately gated operations. Requesting one does not waive the other gates. The command has no action picker or special `help` parser; `/orca` alone asks for your task. This documentation is the request reference, not a new command interface.

## Waiting is not completion

Orca needs the coordinator to end its turn after dispatch so worker reports can wake it. A settled Pi turn is not the requested workflow finishing. Do not keep the coordinator busy with sleep loops or polling merely to change its visual state.

While work remains, the prompt tells the coordinator to name the pending work, state its next check, and keep the session open:

```text
Waiting for 1 worker: the reviewer is checking the draft. I will inspect its changes and test evidence when it reports. Keep this coordinator session open.
Coordination: run <id>; task <id>; dispatch <id>; workspace <path>.

safe_to_close: no
close_reason: The reviewer is active and coordinator review is pending.
next_action: Wait for the worker report, then inspect the changes and checks.
```

The recovery reference lists unresolved assignments and any pending approval. It is a context anchor, not proof of current state. Include it when preserving a compaction summary. After restart or lost context, inspect the recorded Run and workers once and verify coordinator ownership before resuming. Do not start a replacement Run, consume another coordinator's mail, or retry unknown attempts merely because no wake has arrived. Follow the installed recovery guide and report unknown ownership or state as a blocker.

A worker finishing its Task does not finish the requested outcome. Active delegated work, unanswered questions or escalations, pending coordinator review, and unknown outcomes block a completion report. Finished workers and retained terminals have separate lifecycle accounting. Follow the receipt's next action. A worker kept open at your request can be an explicit handoff rather than unfinished work.

The coordinator must not offer optional new tasks while workers are pending. Required blockers and decisions remain visible. Scope completion to your request, not all possible future merge or deployment work. Keep review readiness, commit, publication, merge, deployment, and live verification distinct.

Orca's native `done` badge can describe the coordinator's settled Pi turn even while delegated work continues. The prompt cannot change that badge. Read the waiting reply and reported closing safety in Pi; `KEEP OPEN` means the session must remain open for pending work. Reported closing safety is an agent report, not continuously verified workflow state. No native aggregate waiting-state interface is assumed. Native status support is separate feasibility work; no sidebar override or fake activity is installed by this prompt.

Read-only source research for installed Orca 1.4.271 found that [Pi's `agent_end` maps to `done`](https://github.com/stablyai/orca/blob/6e73dac4be63619d7c870c21648f469a0998a54a/src/shared/agent-hook-listener/providers/pi-family/pi-family-events.ts#L71-L90). Its [child-work fold](https://github.com/stablyai/orca/blob/6e73dac4be63619d7c870c21648f469a0998a54a/src/shared/agent-hook-listener/state/agent-hook-row-child-work-fold.ts#L10-L26) uses a reported subagent roster and command activity. The inspected [supervised orchestration row projection](https://github.com/stablyai/orca/blob/6e73dac4be63619d7c870c21648f469a0998a54a/src/renderer/src/components/sidebar/workspace-card/activity/worktree-agent-row-orchestration.ts#L8-L32) adds Dispatch metadata without changing the row state. The [Crew panel is disabled](https://github.com/stablyai/orca/blob/6e73dac4be63619d7c870c21648f469a0998a54a/src/renderer/src/components/orchestration-crew/use-orchestration-panel-enabled.ts#L1-L4) in that source revision. These findings explain the observed coordinator `done` badge with an active supervised worker, but do not prove how every version or execution host behaves.

No supported coordinator waiting-state override was found in the inspected version and guides. A possible upstream change is a separate host-derived coordination indicator based on unsettled supervised assignments, not a fake busy turn. This is a proposal, not an available API. Filing an upstream issue needs separate approval.

## Per-repo worktree sharing

Orca reads per-repo config for what to materialize into fresh worktrees (clean checkouts miss gitignored paths):

- `orca.yaml` — `worktree.sharedDirectories` (symlink/share large rebuildable trees)
- `.worktreeinclude` — gitignored files to copy per worktree (e.g. `.env`)

Both live in the repo, not in dotfiles.
