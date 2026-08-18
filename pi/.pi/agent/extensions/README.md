# Pi extensions

## Model scores companion

`model-scores/index.ts` is the additive `/model-scores` companion picker for issue #9. It leaves pi's native `/model` and Ctrl+P picker untouched.

The picker reads the current session scope, or the available authenticated model registry when the session is unscoped. It groups Bedrock route duplicates by canonical model ID, keeps exact provider and model identities for selection, displays route and invocation region separately, prefers the current `AWS_REGION`, and shows pi's all zero cost metadata as unknown. It writes a versioned runtime cache only under `~/.pi/agent/data/model-scores.json`, never into this stow package.

The cache uses schema version 1, exact `provider + modelId` keys, nullable unknown values, explicit readiness and freshness states, source status, a two second process lock, restrictive permissions, atomic replacement, and last known good cost preservation. `/model-scores sync` reconciles the current inventory and records a local snapshot without network access. `--provider=name` and `--region=name` filter the picker.

After selecting a model family, the detail view lets the user select an exact route. Successful selection calls `pi.setModel()` with that exact model object and reapplies a pinned thinking level with `pi.setThinkingLevel()`. A rejected `setModel()` keeps the selector open and informs the user.

`pi/.pi/agent/models.json` contains official Bedrock pricing overrides for 54 currently enabled model IDs whose family rates were verified against AWS sources. Route and regional differences are preserved where represented by the installed pi catalog. Configured IDs without verified official pricing are intentionally absent and render as unknown rather than free.

Verification from the repository root:

```sh
bunx vitest run pi/.pi/agent/extensions/model-scores-tests/model-scores-core.test.ts pi/.pi/agent/extensions/model-scores-tests/model-scores-cache.test.ts
pi --no-session --no-extensions -e pi/.pi/agent/extensions/model-scores/index.ts -p 'Reply with exactly OK.'
```

The print mode check verifies that the extension loads without opening the interactive picker. Use `/model-scores` from an interactive pi session to exercise the selector.


## Bedrock GPT 5.6 reasoning

`bedrock-openai-reasoning.ts` is a compatibility extension for OpenAI GPT 5.6 models invoked through Amazon Bedrock's Converse API.

### Why it exists

Pi 0.84.2 correctly exposes reasoning capable GPT 5.6 models and advertises `xhigh` in the model catalog, but its Bedrock adapter only adds reasoning request fields for Claude models. Without this extension, selecting `high`, `xhigh`, or another thinking level changes pi's local state but does not send GPT 5.6's effort parameter to Bedrock.

### How it works

Before each provider request, the extension checks the active model ID for `openai.gpt-5.6-`. For a matching model, it reads pi's effective thinking level and returns the request payload with this Bedrock Converse field merged in:

```json
{
  "additionalModelRequestFields": {
    "reasoning": {
      "effort": "xhigh"
    }
  }
}
```

The mapping is:

| Pi level | Bedrock effort |
| --- | --- |
| `off` | `none` |
| `minimal` | `low` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

It only changes GPT 5.6 Bedrock payloads. Other models and providers are left untouched. It also preserves any existing fields in `additionalModelRequestFields` and any other provider payload fields.

### After changing the thinking level

Use `/reload` after installing or editing the extension. Then select the desired thinking level and send a prompt. The current effective level is available to shell commands as `PI_REASONING_LEVEL`.

### Verification

To verify the extension is present and pi can load it:

```sh
pi --list-models | grep 'gpt-5.6-luna'
```

For a payload level check, temporarily add a `console.log(JSON.stringify(event.payload))` line inside the `before_provider_request` handler, run one small prompt, and remove the logging afterward. Do not leave request payload logging enabled because prompts and tool definitions may contain sensitive data.

## What to do after updating pi

The extension is stored in this dotfiles repository, not inside pi's installed package. A normal pi update should not delete it.

After updating pi:

1. Restart pi or run `/reload`.
2. Run `pi --list-models | grep 'gpt-5.6-luna'`.
3. Check that pi still loads `pi/.pi/agent/extensions/bedrock-openai-reasoning.ts` through `~/.pi/agent/extensions/bedrock-openai-reasoning.ts`.
4. Test one small GPT 5.6 request with `xhigh` selected.
5. If a newer pi release natively supports GPT 5.6 Bedrock effort, remove this workaround only after confirming the native payload behavior. Otherwise, keep it.

Do not edit the installed file under `/opt/homebrew/lib/node_modules`. The source of truth is this file in dotfiles. The live extension path is a symlink created by GNU Stow or the equivalent dotfiles setup.

To check whether the workaround is still needed, inspect the installed adapter for GPT 5.6 handling:

```sh
grep -n -A80 'function buildAdditionalModelRequestFields' \
  /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js
```

If the adapter natively emits `additionalModelRequestFields.reasoning.effort` for OpenAI GPT 5.6 models, disable or remove this extension to avoid duplicate ownership of the behavior. The extension merges the field safely, but native support is preferable.
