# omp (oh-my-pi)

Stow package for [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`), a
heavily diverged fork of [pi](https://github.com/badlogic/pi-mono) with an IDE
(LSP + DAP), persistent code-execution kernels, and an advisor wired in.

Runs fully isolated from the `pi` package: separate binary (`omp` vs `pi`) and
separate config root (`~/.omp/agent` vs `~/.pi/agent`).

## What is stowed

Only `~/.omp/agent/config.yml`. The agent directory itself is created by `omp`
and holds runtime state (`agent.db` auth store, `history.db`, `models.db`,
`sessions/`); stow folds into the existing real directory and symlinks the one
config file, exactly like the `pi` package does with `settings.json`.

```sh
stow omp   # from ~/dotfiles
```

## Install

Via the `brew` package (`Brewfile`): `brew "can1357/tap/omp"`.

## Config (cost-optimized Bedrock)

`config.yml` uses the same Amazon Bedrock backend as
`pi/.pi/agent/settings.json`, with roles tuned for cost: Sonnet as the
workhorse, Haiku for light work, Opus reserved for planning and deliberate
thinking.

- `modelRoles.default` (main loop) -> `eu.anthropic.claude-sonnet-5`
- `modelRoles.smol` / `.tiny` (light + background tasks: titles, memory) -> `eu.anthropic.claude-haiku-4-5`
- `modelRoles.plan` / `.slow` (planning + hard thinking) -> `eu.anthropic.claude-opus-4-8`
- `defaultThinkingLevel: medium`
- `enabledModels`: curated eu/global Bedrock allow-list (same as pi)
- `startup.checkUpdate: false`

The model switcher cycles the cost ladder `smol -> default -> slow`
(Haiku -> Sonnet -> Opus).

Auth uses the ambient AWS credential chain (`AWS_PROFILE=sso-bedrock`), the same
as pi's `amazon-bedrock` provider. No omp equivalent of pi's `aws-sso-refresh`
extension is installed, so run `aws sso login --profile sso-bedrock` when the
session expires.

## Global preferences (AGENTS.md)

Not duplicated here. omp's `claude` discovery source reads `~/.claude/CLAUDE.md`
(symlinked to the canonical `pi/.pi/agent/AGENTS.md`), so the same global
preferences apply automatically. Adding `~/.omp/agent/AGENTS.md` would only
double-load the same content.

## Not ported from pi

pi's local extensions (`aws-sso-refresh`, `notifications`, `status-bar`,
`mcp-bridge`, `mdx`, `forget-session`) and npm packages (`pi-hermes-memory`,
`@tintinweb/pi-subagents`) target pi's `@earendil-works/pi-coding-agent`
extension API and are not compatible with omp's fork. omp ships native
equivalents (built-in memory, advisor/watchdog, task subagents, MCP,
marketplace plugins); wire those up separately if the trial sticks.
