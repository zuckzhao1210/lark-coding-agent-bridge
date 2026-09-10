import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelCard } from '../../../src/card/model-card';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  DEFAULT_MODEL,
  isDefaultModel,
  modelLabel,
  profileModelHome,
  normalizeModelSelection,
  resolveModelArg,
  resolveModelCommandSelection,
  supportedModels,
  supportedReasoningLevels,
  resolveReasoningEffortArg,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'model-catalog-'));
    vi.stubEnv('CODEX_HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('matches CLI visibility and priority, including Spark, and refreshes changed caches', () => {
    const cache = join(home, 'models_cache.json');
    writeFileSync(cache, JSON.stringify({ models: [
      { slug: 'gpt-5.3-codex-spark', display_name: 'GPT-5.3-Codex-Spark', visibility: 'list', priority: 26, supported_in_api: false },
      { slug: 'hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 12 },
      { slug: 'gpt-5.5', visibility: 'list', priority: 13 },
      null, { visibility: 'list' },
    ] }));
    expect(supportedModels('codex')).toEqual([
      { value: 'default', label: '跟随默认（不指定）' },
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
    ]);
    expect(resolveModelCommandSelection('codex', 'spark')).toBe('gpt-5.3-codex-spark');
    expect(resolveModelArg('codex', 'gpt-5.5')).toBe('gpt-5.5');
    expect(JSON.stringify(modelCard('codex', 'gpt-5.5'))).toContain('✓ GPT-5.5');
    expect(JSON.stringify(modelCard('codex', 'gpt-5.5'))).not.toContain('hidden');

    writeFileSync(cache, JSON.stringify({ models: [
      { slug: 'future-model', display_name: 'Future Model', visibility: 'list', priority: 1 },
    ] }));
    expect(supportedModels('codex').map((model) => model.value)).toEqual(['default', 'future-model']);
    expect(resolveModelArg('codex', 'future-model')).toBe('future-model');
    expect(supportedModels('claude').some((model) => model.value === 'future-model')).toBe(false);

    writeFileSync(cache, '{partial');
    expect(supportedModels('codex').map((model) => model.value)).toEqual(['default', 'future-model']);
  });

  it('uses model-specific reasoning levels and defaults without inventing fallback options', () => {
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'model-a', visibility: 'list', default_reasoning_level: 'ultra', supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' }, { effort: 'ultra', description: 'Deep' },
        { effort: 'ultra' }, null, { effort: 'bad"value' },
      ] },
      { slug: 'model-b', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [
        { effort: 'medium' }, { effort: 'high' },
      ] },
      { slug: 'no-metadata', visibility: 'list' },
    ] }));
    expect(supportedReasoningLevels('codex', 'model-a')).toEqual([
      { effort: 'low', description: 'Fast' }, { effort: 'ultra', description: 'Deep' },
    ]);
    expect(resolveReasoningEffortArg('codex', 'model-a', 'ultra')).toBe('ultra');
    expect(resolveReasoningEffortArg('codex', 'model-b', 'ultra')).toBe('medium');
    expect(resolveReasoningEffortArg('codex', 'model-b', undefined)).toBeUndefined();
    expect(resolveReasoningEffortArg('claude', 'model-a', 'ultra')).toBeUndefined();
    expect(supportedReasoningLevels('codex', 'no-metadata')).toEqual([]);
    expect(supportedReasoningLevels('codex', 'default')).toEqual([]);
    const card = JSON.stringify(modelCard('codex', 'model-b', false, home, 'high'));
    expect(card).toContain('✓ high');
    expect(card).toContain('model-b medium');
    expect(card).not.toContain('model-b ultra');
    expect(JSON.stringify(modelCard('claude', undefined))).not.toContain('model.effort');
  });

  it('uses the same explicit, isolated, or inherited home as the Codex adapter', () => {
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
      codex: { binaryPath: 'codex', inheritCodexHome: true },
    });
    const state = { profile: 'codex', configPath: join(home, 'config.json'), profileConfig };
    expect(profileModelHome(state)).toBeUndefined();
    profileConfig.codex!.inheritCodexHome = false;
    expect(profileModelHome(state)).toBe(join(home, 'profiles', 'codex', 'codex-home'));
    profileConfig.codex!.codexHome = join(home, 'custom');
    expect(profileModelHome(state)).toBe(join(home, 'custom'));
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'only-in-inherited-home', visibility: 'list' },
    ] }));
    expect(supportedModels('codex', profileModelHome(state)).map((model) => model.value))
      .not.toContain('only-in-inherited-home');
  });

  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toContain('gpt-5-codex');
    expect(codex.map((m) => m.value)).toEqual(expect.arrayContaining([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]));
    expect(claude.map((m) => m.value)).not.toContain('gpt-5-codex');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('coerces unknown / cross-agent selections back to the default option', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    // A Codex model left over after switching a profile to Claude is invalid.
    expect(normalizeModelSelection('claude', 'gpt-5-codex')).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    // Cross-agent value → no flag rather than a broken model.
    expect(resolveModelArg('codex', 'claude-opus-4-8')).toBeUndefined();
  });

  it('resolves Codex chat aliases and full model IDs', () => {
    expect(resolveModelCommandSelection('codex', ' ASTRA ')).toBe('gpt-6-astra');
    expect(resolveModelArg('codex', 'gpt-6-astra')).toBe('gpt-6-astra');
    expect(resolveModelCommandSelection('codex', 'sol')).toBe('gpt-5.6-sol');
    expect(resolveModelCommandSelection('codex', ' TERRA ')).toBe('gpt-5.6-terra');
    expect(resolveModelCommandSelection('codex', 'luna')).toBe('gpt-5.6-luna');
    expect(resolveModelCommandSelection('codex', 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(resolveModelCommandSelection('codex', DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
    expect(resolveModelCommandSelection('codex', 'unknown')).toBeUndefined();
    expect(resolveModelCommandSelection('claude', 'sol')).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8（最新）');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });
});
