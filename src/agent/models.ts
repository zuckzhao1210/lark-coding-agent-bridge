import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
  reasoningLevels?: ReasoningLevel[];
  defaultReasoningEffort?: string;
}

export interface ReasoningLevel {
  effort: string;
  description: string;
}

function reasoningMetadata(model: { supported_reasoning_levels?: unknown; default_reasoning_level?: unknown }): Partial<ModelOption> {
  if (!Array.isArray(model.supported_reasoning_levels)) return {};
  const seen = new Set<string>();
  const reasoningLevels: ReasoningLevel[] = [];
  for (const level of model.supported_reasoning_levels) {
    if (!level || typeof level.effort !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(level.effort)
      || seen.has(level.effort)) continue;
    seen.add(level.effort);
    reasoningLevels.push({ effort: level.effort, description: typeof level.description === 'string' ? level.description : '' });
  }
  const defaultReasoningEffort = typeof model.default_reasoning_level === 'string'
    && seen.has(model.default_reasoning_level) ? model.default_reasoning_level : undefined;
  return { reasoningLevels, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) };
}

/**
 * Claude Code models. Pinned to concrete version ids (Claude Code's `--model`
 * accepts the full model-id string, not just the `opus`/`sonnet` aliases) so
 * the picker names an exact model. Add new ids here when a generation ships;
 * `opusplan` is kept as the one alias with no versioned equivalent (it runs
 * Opus for planning and Sonnet for execution).
 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8（最新）' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/** Fallback for profiles whose CLI has not populated its model cache yet. */
const CODEX_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'gpt-6-astra', label: 'GPT-6 Astra（最新）' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'o3', label: 'o3' },
];

const CODEX_MODEL_ALIASES: Readonly<Record<string, string>> = {
  astra: 'gpt-6-astra',
  sol: 'gpt-5.6-sol',
  terra: 'gpt-5.6-terra',
  luna: 'gpt-5.6-luna',
  spark: 'gpt-5.3-codex-spark',
};

/** Match the CODEX_HOME used by the profile's Codex adapter. */
export function profileModelHome(state: {
  profile: string;
  configPath: string;
  profileConfig: ProfileConfig;
}): string | undefined {
  const codex = state.profileConfig.codex;
  if (codex?.codexHome) return codex.codexHome;
  if (codex && codex.inheritCodexHome !== true) {
    return join(resolveAppPaths({ rootDir: dirname(state.configPath), profile: state.profile }).profileDir, 'codex-home');
  }
  return undefined;
}

const cachedCatalogs = new Map<string, { signature: string; models: ModelOption[] }>();

/** Read only picker-visible models; Spark is visible even though supported_in_api is false. */
function codexModels(codexHome?: string): ModelOption[] {
  const path = join(codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
  try {
    const stat = statSync(path);
    const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
    const cached = cachedCatalogs.get(path);
    if (cached?.signature === signature) return cached.models;
    const data = JSON.parse(readFileSync(path, 'utf8')) as { models?: unknown };
    if (!Array.isArray(data.models)) return cached?.models ?? CODEX_MODELS;
    const visible = data.models.filter((model): model is {
      slug: string; display_name?: string; priority?: number;
      supported_reasoning_levels?: unknown; default_reasoning_level?: unknown;
    } => model && typeof model === 'object' && model.visibility === 'list'
      && typeof model.slug === 'string' && model.slug.trim() !== '' && model.slug !== DEFAULT_MODEL);
    visible.sort((a, b) => (typeof a.priority === 'number' ? a.priority : Infinity)
      - (typeof b.priority === 'number' ? b.priority : Infinity));
    const seen = new Set<string>();
    const models: ModelOption[] = [{ value: DEFAULT_MODEL, label: '跟随默认（不指定）' }];
    for (const model of visible) {
      if (seen.has(model.slug)) continue;
      seen.add(model.slug);
      models.push({ value: model.slug, label: typeof model.display_name === 'string' && model.display_name.trim()
        ? model.display_name : model.slug, ...reasoningMetadata(model) });
    }
    if (models.length === 1) return cached?.models ?? CODEX_MODELS;
    cachedCatalogs.set(path, { signature, models });
    return models;
  } catch {
    // CLI can replace its cache while a card is opening. Retain the last good list.
    return cachedCatalogs.get(path)?.models ?? CODEX_MODELS;
  }
}

/** CLI cache changes are picked up on the next read without restarting the bridge. */
export function supportedModels(agentKind: AgentKind, codexHome?: string): ModelOption[] {
  return agentKind === 'codex' ? codexModels(codexHome) : CLAUDE_MODELS;
}

export function supportedReasoningLevels(agentKind: AgentKind, model: string | undefined, codexHome?: string): ReasoningLevel[] {
  if (agentKind !== 'codex' || isDefaultModel(model)) return [];
  return supportedModels(agentKind, codexHome).find((option) => option.value === model)?.reasoningLevels ?? [];
}

/** Unset follows CLI configuration; incompatible explicit efforts use the model's default. */
export function resolveReasoningEffortArg(
  agentKind: AgentKind, model: string | undefined, effort: string | undefined, codexHome?: string,
): string | undefined {
  if (agentKind !== 'codex' || !effort || effort === DEFAULT_MODEL || isDefaultModel(model)) return undefined;
  const option = supportedModels(agentKind, codexHome).find((candidate) => candidate.value === model);
  return option?.reasoningLevels?.some((level) => level.effort === effort)
    ? effort : option?.defaultReasoningEffort;
}

/**
 * Resolve a `/model` argument to a supported stored selection. Full model IDs
 * work for every agent; Codex additionally accepts the short Astra/Sol/Terra/Luna
 * names used in chat. Matching is case-insensitive for a friendlier command
 * surface. Returns undefined when the input is not in the current catalog.
 */
export function resolveModelCommandSelection(
  agentKind: AgentKind,
  input: string,
  codexHome?: string,
): string | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === DEFAULT_MODEL) return DEFAULT_MODEL;

  const aliased = agentKind === 'codex'
    ? (CODEX_MODEL_ALIASES[normalized] ?? normalized)
    : normalized;
  return supportedModels(agentKind, codexHome).find((model) => model.value.toLowerCase() === aliased)?.value;
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Coerce a stored model preference into a value guaranteed to be one of the
 * current agent's picker options — Feishu's `select_static` requires
 * `initial_option` to match an option value exactly. Unknown / cross-agent
 * values (e.g. a Claude alias left over after switching a profile to Codex)
 * fall back to {@link DEFAULT_MODEL}.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
  codexHome?: string,
): string {
  if (isDefaultModel(value)) return DEFAULT_MODEL;
  return supportedModels(agentKind, codexHome).some((m) => m.value === value)
    ? (value as string)
    : DEFAULT_MODEL;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag. Cross-agent / unknown values are treated as "default".
 */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
  codexHome?: string,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value, codexHome);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined, codexHome?: string): string {
  const normalized = normalizeModelSelection(agentKind, value, codexHome);
  return supportedModels(agentKind, codexHome).find((m) => m.value === normalized)?.label ?? normalized;
}
