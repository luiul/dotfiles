# Model availability vocabulary

Status: implemented, 2026-10-01 (agreed 2026-09-30, see Decisions). The tool is `pi-model-sync` (https://github.com/luiul/orchard). Tracked in https://github.com/luiul/dotfiles/issues/27.
Scope: the setup that discovers which models pi can use, and the tool that keeps pi's config matching reality. The tool works for both providers: amazon-bedrock and ai-model-router.

This document fixes one meaning per term. Every term maps to a concrete file, command, or API in the current setup. When we discuss the new tool, use these terms and say which rung of the ladder you mean.

## The two providers

### amazon-bedrock

- pi's built-in AWS Bedrock provider.
- Auth: AWS SSO profile `sso-bedrock`. No API key.
- Region: the `AWS_REGION` env var, else the profile's region (`eu-west-1`). pi has no per-model region setting. One region is active per pi process.
- pi's Bedrock catalog is static and bundled with pi. It grows with pi upgrades. Today it lists 177 model ids.

### ai-model-router ("the router")

- HelloFresh's internal AI Model Router. A LiteLLM gateway with one base URL: `https://ai-model-router-api.eu.foundations.prod.int.hellofresh.io/v1`
- A custom pi provider, defined in `pi/.pi/agent/models.json`.
- Wire format: `openai-completions`. Auth: the `$AI_MODEL_ROUTER_API_KEY` env var. The real value lives in gitignored `~/dotfiles/.env`.
- No regions. The gateway routes to backends itself.
- pi's router catalog is the hand-written model list in `models.json`. Today it lists 11 model ids.

## The availability ladder

"Available model" is ambiguous. There are six distinct sets. Each rung is a subset of the rung above. Name the rung when you talk about availability.

1. **Catalog model**: pi knows the id. Source: `pi --list-models`. Bedrock side: pi's bundled catalog. Router side: the hand-written `models.json` list.
2. **Entitled model** (Bedrock only): the AWS account may call it in a given region. Two disjoint sources per region, because Bedrock has two invocation modes:
   - `aws bedrock list-inference-profiles`: inference profile ids for INFERENCE_PROFILE-only models (all current Claude). The id prefix shows the region group: `eu.`, `us.`, `jp.`, `au.`, `global.`, `apac.`.
   - `aws bedrock list-foundation-models` filtered to ON_DEMAND: bare ids (`qwen.*`, `mistral.*`, ...). A model appears here only in the regions where it is deployed. These ids never appear in list-inference-profiles.

   Router models have no entitlement concept. The API key grants access to whatever the gateway deploys.
3. **Deployed model** (router only): the router serves it right now. Source: live `GET /v1/models`. This is ground truth. HelloDev docs can be stale and have listed models that were not deployed. The companion `GET /v1/model/info` returns cost and context metadata (sometimes null).
4. **Candidate**: catalog ∩ entitled (Bedrock, per region, exact id match), or catalog-relevant deployed ids (router). A candidate is worth probing.
5. **Invocable model** (also: probe-verified, usable): a candidate that answers a live probe through pi. Only a live probe is reliable:
   - pi exits 0 even when the model call fails. It prints the error as text.
   - Entitlement cannot predict per-model failures (marketplace subscription missing, no streaming tool use, data retention mode rejected).
6. **Enabled model**: appears in `/model` and Ctrl+P. Source: `enabledModels` in `pi/.pi/agent/settings.json`. A hand-curated list of minimatch patterns, not explicit ids. A `:level` suffix pins a thinking level (example: `gpt-5.6-luna:max`).

All rungs exist for both providers now: router models are probed like Bedrock ones, and pattern validation matches against probe-verified ids on both sides.

## Supporting terms

- **Curated pattern**: one entry in `enabledModels` in the dotfiles copy of `pi/.pi/agent/settings.json`. That list is the single store of patterns: `pi-model-sync` validates each pattern (glob-match after stripping a `:level` pin) against invocable Bedrock ids plus probe-verified router ids, flags dead patterns and uncovered models, and never edits the list itself.
- **Dead pattern**: a curated pattern that matches nothing currently invocable. Usually means a retired or renamed model.
- **Default region**: the region pi uses when `AWS_REGION` is unset. `eu-west-1` in this setup.
- **Region prefix / home region**: the prefix of a Bedrock inference profile id. It maps to the region group where the id is invocable: `eu.` → eu-west-1, `us.` → us-east-1, `jp.` → ap-northeast-1, `au.` → ap-southeast-2, `apac.` → ap-northeast-1, `global.` → any scanned region.
- **Region map**: `pi/.pi/agent/bedrock-models.json`. A `{modelId: region}` map of every invocable Bedrock model across all scanned regions (103 models at the 2026-10-01 sync). Consumers: the `bedrock-region-sync.ts` pi extension (sets `AWS_REGION` on model_select and session_start) and the zsh functions `pi-models`, `pi-region`, `pi-use`.
- **Probe**: `pi -p "hi" --provider <p> --model <id> --no-session --no-extensions` with a timeout. Classified by output text, never by exit code.
- **Model override**: a per-model cost entry under `amazon-bedrock.modelOverrides` in `models.json`. Router models carry full definitions instead (cost, contextWindow, maxTokens), because pi has no built-in data for them. Router definitions are generated by `pi-model-sync` from the live gateway; the metadata chain per field is: the registry first (human authority, fills nulls and corrects wrong values), then live gateway info, then pi's bundled provider data.
- **Model registry**: `pi/.pi/agent/model-registry.json`, stowed. Hand-maintained model knowledge: `probeRegionOverrides` (pin a model id to its probe region) and `routerModelOverrides` (human authority over router metadata: fills nulls and corrects present-but-wrong values, e.g. a backend that rejects the advertised maxTokens).

## Current tools and their coverage

| Tool | Provider | Inputs | Outputs |
| --- | --- | --- | --- |
| `pi-model-sync` | both | AWS entitlements, pi catalog, live router deployment, live probes | unified report, `bedrock-models.json`, router section of `models.json` (generated); validates `enabledModels` patterns in place |
| `sync-zed-router-models.sh` | router | live `/v1/models`, `/v1/model/info`, pi `models.json` | Zed `available_models` |
| `pi-models` / `pi-region` / `pi-use` (zsh) | Bedrock | `bedrock-models.json` | shell region switching |

`pi-model-sync` replaced `sync-enabled-models.sh` on 2026-10-01 after a same-day parity run (identical region assignments; invocable-set differences were transient probe flakes on both sides). It closed the old gaps: pi's router entries are generated from the live gateway, router models are probed, and `pi-model-sync report` answers "what can I use right now, across both providers?"

## Known drift, measured 2026-09-30

Live router deployment (13 models) vs pi's hand-written `models.json` (11 models):

- Deployed but unknown to pi (6): `claude-opus-5-5`, `claude-sonnet-5-5`, `deepseek-ai/DeepSeek-V4.1-Flash`, `gpt-6-luna`, `gpt-6-sol`, `zai-org/GLM-5.3-Flash`.
- Listed in pi but no longer deployed (4): `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `zai-org/GLM-5.2`.
- Side effect: the curated patterns `claude-opus-5*`, `claude-opus-4-8*`, `claude-sonnet-4-6*` and `zai-org/GLM-5*` match the stale catalog, so nothing flags the drift. The picker offers models the router removed.

This drift was the concrete motivation for the tool. The first `pi-model-sync sync` run (2026-10-01) found exactly these 6+4, regenerated `models.json` (13 deployed entries), and flagged the 4 dead patterns plus 82 invocable models no pattern covers (mostly the `jp.`/`au.`/`apac.` set decision 5 surfaces).

## Decisions (agreed 2026-09-30)

1. **The tool probes both providers.** Router probing needs VPN plus `AI_MODEL_ROUTER_API_KEY` (from gitignored `~/dotfiles/.env`). When the router is unreachable the report marks router rungs unknown instead of failing. Deployed does not imply invocable for the router either, same as Bedrock.
2. **pi's router entries in `models.json` become generated**, from live `/v1/models` plus `/v1/model/info`. Fallback chain for null metadata: pi's bundled provider data, then a small hand-maintained overrides table. The hand-written model list goes away.
3. **One unified report across both providers.** One row per model, provider column, one flag per rung. The ladder gives the shared format for free.
4. **The tool reports and writes artifacts**: `enabledModels`, `bedrock-models.json`, `models.json`. It never auto-edits curated patterns (same rule as today). It flags dead patterns and invocable models no pattern covers; a human edits the list.
5. **The eu/us/global-only constraint is removed.** `CURATED_PATTERNS` in `sync-enabled-models.sh` pins Anthropic Bedrock patterns to `eu.`, `us.`, `global.` only. The probe run already verifies 17 `jp.`/`au.`/`apac.` models into the region map (example: `au.anthropic.claude-opus-5`), but no pattern can match them, so the picker never offers them. The new tool derives prefix coverage from the regions actually scanned instead of hardcoding three.
6. **The fetcher is a Python CLI managed with uv.** Same stack as coppice (`~/projects/personal/coppice`, https://github.com/luiul/coppice): typer, rich, hatchling, src layout, ruff, ty, pytest. It lives in its own repo `~/projects/personal/orchard` (renamed from `pi-model-sync`; name agreed 2026-09-30) and replaces `sync-enabled-models.sh` once it reaches parity. The Zed sync (`sync-zed-router-models.sh`) is out of scope and stays untouched.
