# Pi model discovery and selection

**TLDR:** [grove](https://github.com/luiul/grove) fetches and validates models, stores the results, and projects them into `models.json`. Pi's native `/model` selects them. The grove store is the single source of truth. Pi config in this repo is a projection.

## Canonical concepts

The [grove README](https://github.com/luiul/grove#vocabulary) defines the terms: source, discovery, store, entry, status, partition, probe, validation, refresh, projection, region map, curated config. Use those instead of "available". A listing is never proof that a call works; only a probe is. The full spec lives in https://github.com/luiul/grove/issues/1.

## Files and ownership

- `~/projects/personal/grove/store.json`: the incremental database, committed to the grove repo. A model once validated is never probed again.
- `pi/.pi/agent/models.json`: the projection grove writes (its live file is stowed). Two parts are grove-owned: `providers["ai-model-router"].models` and the top-level `grove` key (the Bedrock region map). Everything else is curated by hand, for example the `amazon-bedrock` cost overrides.
- `~/.pi/agent/settings.json` is Pi's live file. `pi/.pi/agent/settings.json` is the tracked snapshot, not a Stow symlink. grove never touches either. Save defaults or scope in Pi, then copy the live file to the snapshot.
- `~/projects/personal/grove/overlay.json` holds curated per-model fields (display names, corrections) merged into the projection. It replaces the old hand-maintained `model-registry.json`, which is deleted.

The router uses `AI_MODEL_ROUTER_API_KEY` (environment or the gitignored `.env`). Bedrock uses the `sso-bedrock` AWS profile. Never commit resolved credentials. grove never runs `aws sso login` automatically.

## Region coverage

grove fetches and probes only the configured region allowlist (default: eu-west-1, us-east-1, ap-northeast-1, ap-southeast-2). A region-prefix hint is not proof of where a call works; the probe records the region that succeeded.

The Pi region extension switches `AWS_REGION` from the `grove` key on session start and model selection. Unknown IDs fall back to the map's default region. The map does not change `enabledModels`.

## History

Replaces orchard (too complicated: it re-probed everything on every sync) and the older Python `pi-model-sync`. Earlier decisions remain in https://github.com/luiul/dotfiles/issues/27 and https://github.com/luiul/orchard/issues/9.
