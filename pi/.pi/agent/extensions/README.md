# Pi extensions

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
