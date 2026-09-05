// sync-router-models.ts: compute Zed's ai-model-router available_models from
// the live router deployment and write them into Zed's settings.json without
// touching comments or other settings (jsonc-parser edit, not a rewrite).
//
// Called by sync-zed-router-models.sh:
//   sync-router-models.ts <zed-settings> <pi-models.json> <deployed.json> <model-info.json> [--dry-run]
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { parse, modify, applyEdits, printParseErrorCode, type ParseError } from "jsonc-parser";

const [settingsPath, piModelsPath, deployedPath, infoPath, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");

interface PiModel {
  id: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

// Full object is required: Zed's capabilities fields have no per-field
// defaults, so a partial object like { "images": true } fails to parse.
// Values match Zed's documented defaults.
const CAPABILITIES_DEFAULTS = {
  tools: true,
  images: false,
  parallel_tool_calls: false,
  prompt_cache_key: false,
  chat_completions: true,
  interleaved_reasoning: false,
  max_tokens_parameter: false,
};
const CAPABILITIES_WITH_IMAGES = { ...CAPABILITIES_DEFAULTS, images: true };

interface ZedModel {
  name: string;
  display_name: string;
  max_tokens: number;
  max_output_tokens?: number;
  capabilities?: typeof CAPABILITIES_DEFAULTS;
}

// Zed-specific fixes that pi's models.json cannot express.
const ZED_MODEL_OVERRIDES: Record<string, (z: ZedModel) => void> = {
  // gpt-5.6-luna rejects the temperature field. Zed's chat-completions builder
  // always sends temperature (defaults to 1.0), while its Responses builder
  // omits it when unset. The router supports /responses for luna (verified
  // 2026-09-05), so force the Responses API for this model.
  "gpt-5.6-luna": (z) => {
    z.capabilities = { ...(z.capabilities ?? CAPABILITIES_DEFAULTS), chat_completions: false };
  },
};

const piModels = (JSON.parse(readFileSync(piModelsPath, "utf8")).providers?.["ai-model-router"]?.models ??
  []) as PiModel[];
const piById = new Map(piModels.map((m) => [m.id, m]));

const deployed: string[] = (JSON.parse(readFileSync(deployedPath, "utf8")).data ?? [])
  .map((m: any) => m.id)
  .sort();

const infoById = new Map<string, any>(
  (JSON.parse(readFileSync(infoPath, "utf8")).data ?? []).map((d: any) => [d.model_name, d.model_info ?? {}]),
);

// Sibling fallback for deployed models that have no metadata anywhere.
// Key: deployed id without metadata. Value: sibling id to copy limits from.
const FALLBACKS: Record<string, string> = {
  "zai-org/GLM-5.3": "zai-org/GLM-5.2",
};

const ACRONYMS: Record<string, string> = {
  claude: "Claude",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  glm: "GLM",
  gpt: "GPT",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  luna: "Luna",
  nova: "Nova",
  mistral: "Mistral",
  qwen: "Qwen",
};

// "zai-org/GLM-5.3" -> "GLM-5.3", "claude-opus-5-1m" -> "Claude Opus 5 1M"
function prettify(id: string): string {
  const base = id.split("/").pop()!;
  const tokens = base.split("-").map((t) => {
    const lower = t.toLowerCase();
    if (ACRONYMS[lower]) return ACRONYMS[lower];
    if (/^\d/.test(t)) return t.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  });
  // Join a version token onto a preceding acronym with a dash: "GLM 5.3" -> "GLM-5.3"
  const joined: string[] = [];
  for (const t of tokens) {
    const prev = joined[joined.length - 1];
    if (prev && /^\d/.test(t) && /^[A-Z]{2,}$/.test(prev)) {
      joined[joined.length - 1] = `${prev}-${t}`;
    } else {
      joined.push(t);
    }
  }
  return joined.join(" ");
}

function fromPi(id: string, p: PiModel): ZedModel | null {
  if (!p.contextWindow) return null;
  const z: ZedModel = { name: id, display_name: p.name ?? prettify(id), max_tokens: p.contextWindow };
  if (p.maxTokens) z.max_output_tokens = p.maxTokens;
  if (p.input?.includes("image")) z.capabilities = { ...CAPABILITIES_WITH_IMAGES };
  return z;
}

function fromRouterInfo(id: string): ZedModel | null {
  const mi = infoById.get(id);
  if (!mi?.max_input_tokens) return null;
  const z: ZedModel = { name: id, display_name: prettify(id), max_tokens: mi.max_input_tokens };
  if (mi.max_output_tokens) z.max_output_tokens = mi.max_output_tokens;
  if (mi.supports_vision === true) z.capabilities = { ...CAPABILITIES_WITH_IMAGES };
  return z;
}

// Metadata priority: pi models.json, then router model_info, then sibling fallback.
function resolve(id: string, seen = new Set<string>()): ZedModel | null {
  if (seen.has(id)) return null;
  seen.add(id);
  const p = piById.get(id);
  if (p) {
    const z = fromPi(id, p);
    if (z) return z;
  }
  const z = fromRouterInfo(id);
  if (z) return z;
  const fb = FALLBACKS[id];
  if (fb) {
    const zfb = resolve(fb, seen);
    if (zfb) return { ...zfb, name: id, display_name: p?.name ?? prettify(id) };
  }
  return null;
}

const usable: ZedModel[] = [];
const skipped: string[] = [];
for (const id of deployed) {
  const z = resolve(id);
  if (!z) {
    skipped.push(id);
    continue;
  }
  ZED_MODEL_OVERRIDES[id]?.(z);
  usable.push(z);
}
const notDeployed = piModels.filter((m) => !deployed.includes(m.id)).map((m) => m.id);

// Zed's Bedrock catalog contains lookalike models (Claude generations, and
// GPT-5.6 Luna via bedrock-mantle, which our IAM role cannot call). The
// suffix makes the router copies distinguishable in the model picker.
for (const z of usable) z.display_name = `${z.display_name} (Router)`;

const text = readFileSync(settingsPath, "utf8");
const errors: ParseError[] = [];
const settings = parse(text, errors, { allowTrailingComma: true });
if (errors.length) {
  console.error(`${settingsPath} has parse errors, refusing to edit:`);
  for (const e of errors) console.error(`  offset ${e.offset}: ${printParseErrorCode(e.error)}`);
  process.exit(1);
}

const current: ZedModel[] =
  settings?.language_models?.openai_compatible?.["ai-model-router"]?.available_models ?? [];
const curNames = new Set(current.map((m) => m.name));
const newNames = new Set(usable.map((m) => m.name));
const added = usable.map((m) => m.name).filter((n) => !curNames.has(n));
const removed = [...curNames].filter((n) => !newNames.has(n));

console.log(`deployed: ${deployed.length}, usable: ${usable.length}, currently in zed: ${current.length}`);
if (added.length) console.log(`added:   ${added.join(", ")}`);
if (removed.length) console.log(`removed: ${removed.join(", ")}`);
if (skipped.length) console.log(`skipped (deployed but no metadata): ${skipped.join(", ")}`);
if (notDeployed.length) console.log(`note: in pi config but not deployed: ${notDeployed.join(", ")}`);

const dm = settings?.agent?.default_model;
if (dm?.provider === "ai-model-router" && !newNames.has(dm.model)) {
  console.warn(`WARNING: agent.default_model '${dm.model}' is not in the synced list`);
}

if (JSON.stringify(current) === JSON.stringify(usable)) {
  console.log("already in sync, no write needed");
  process.exit(0);
}

if (dryRun) {
  console.log("dry run, settings.json left unchanged");
  console.log(JSON.stringify(usable, null, 2));
  process.exit(0);
}

const edits = modify(
  text,
  ["language_models", "openai_compatible", "ai-model-router", "available_models"],
  usable,
  { formattingOptions: { tabSize: 2, insertSpaces: true } },
);
// Atomic write: Zed watches and reloads this file, and a truncated read
// makes it fall back to stale settings. Temp file + rename avoids that race.
const tmp = `${settingsPath}.sync-tmp`;
writeFileSync(tmp, applyEdits(text, edits));
renameSync(tmp, settingsPath);
console.log(`wrote ${usable.length} models to ${settingsPath}`);
