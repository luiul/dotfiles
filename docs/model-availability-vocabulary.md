# Pi model discovery and selection

**TLDR:** [Orchard](https://github.com/luiul/orchard) discovers and probes models. Pi's native `/model` selects them. Discovery, invocation, and curated scope are separate facts.

## Canonical concepts

The [Orchard README](https://github.com/luiul/orchard#concepts) defines catalog, listed, deployed, candidate, invocable, scoped, and unknown. Use those terms instead of “available” or an availability ladder. AWS listings and router deployment are not proof that a Pi invocation works. `enabledModels` controls startup scope and cycling, not provider access. An empty or unmatched scope falls back to all authenticated models. Pi's `/model` can show other catalog entries.

## Files and ownership

- `~/.pi/agent/settings.json` is Pi's live source of truth. `pi/.pi/agent/settings.json` is the tracked snapshot, not a Stow symlink. Save defaults or scope in Pi, then copy the live file to the snapshot.
- `pi/.pi/agent/models.json` defines `ai-model-router` and Bedrock metadata overrides. Its live file is stowed. Orchard changes only the generated router model definitions after probing them.
- `pi/.pi/agent/bedrock-models.json` stores each verified Bedrock model's working region. Its live file is stowed. The region extension and shell helpers read it.
- `pi/.pi/agent/model-registry.json` stores explicit region and router metadata overrides. It stays hand-maintained.

The router uses the environment variable `AI_MODEL_ROUTER_API_KEY`. Bedrock uses AWS credentials, normally the `sso-bedrock` profile. Never commit resolved credentials. Orchard never runs `aws sso login` automatically.

## Region coverage

There is no EU or US filter in Orchard. It scans all configured regions, including Japan and Australia by default. It probes discovered catalog models, scoped models, and previously mapped models. A model outside the curated scope can still be invocable. A region-prefix hint is not proof of where a call works; the probe records the region that succeeded.

The Pi region extension switches `AWS_REGION` using the verified map on session start and model selection. If an ID is missing, the extension currently falls back to the map's default region. The map does not change `enabledModels` automatically.

## Transition and scope

The older Python command is still installed as `pi-model-sync` until the Go path has passed live verification. Do not treat the two report schemas as identical. The simplified workflow and safety checks are documented in [Orchard](https://github.com/luiul/orchard). Earlier decisions remain in https://github.com/luiul/dotfiles/issues/27 and https://github.com/luiul/orchard/issues/9.

Zed's router sync is independent and outside this change. The zsh helpers `pi-models`, `pi-region`, and `pi-use` also remain available. No default model, curated scope, or authentication setting changes as part of this simplification.
