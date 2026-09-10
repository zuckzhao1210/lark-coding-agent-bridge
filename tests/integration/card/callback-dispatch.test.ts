import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardActionEvent } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { modelCard } from '../../../src/card/model-card.js';
import { sendManagedCard } from '../../../src/card/managed.js';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('signed card callback dispatch', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('switches models from card buttons, persists defaults, and checks admin access', async () => {
    const h = await createHarness();
    h.controls.profileConfig.agentKind = 'codex';
    h.controls.profileConfig.codex = { binaryPath: 'codex', inheritCodexHome: false };
    await saveRootConfig(createRootConfig('claude', h.controls.profileConfig), h.controls.configPath);
    const channel = h.channel as unknown as Parameters<typeof sendManagedCard>[0];
    const card = modelCard('codex', undefined) as {
      body: { elements: Array<{ behaviors?: Array<{ value: Record<string, unknown> }> }> };
    };
    const astra = card.body.elements.flatMap((el) => el.behaviors ?? [])
      .find((behavior) => behavior.value.arg === 'gpt-6-astra')!.value;
    await sendManagedCard(channel, 'oc_group', card);

    // A group member can see the card but cannot change profile settings.
    await h.dispatch(astra);
    expect(h.controls.profileConfig.preferences.model).toBeUndefined();

    h.controls.profileConfig.access.admins = ['ou_operator'];
    await saveRootConfig(createRootConfig('claude', h.controls.profileConfig), h.controls.configPath);
    await h.dispatch(astra);
    expect(h.controls.profileConfig.preferences.model).toBe('gpt-6-astra');
    expect((await loadRootConfig(h.controls.configPath))?.profiles.claude?.preferences.model).toBe('gpt-6-astra');
    const updates = () => h.channel.rawClient.requests.filter((request) => request.method === 'cardkit.v1.card.update');
    expect(updates()).toHaveLength(0); // The callback must return before updating the card.
    await vi.waitFor(() => expect(updates()).toHaveLength(1), { timeout: 2000 });
    expect(JSON.stringify(updates())).toContain('✓ GPT-6 Astra');


    await h.dispatch({ cmd: 'model.select', arg: 'unsupported' });
    expect(h.controls.profileConfig.preferences.model).toBe('gpt-6-astra');
    await h.dispatch({ cmd: 'model.select', arg: 'sol' });
    await h.dispatch({ cmd: 'model.select', arg: 'default' });
    expect(h.controls.profileConfig.preferences.model).toBeUndefined();
    expect((await loadRootConfig(h.controls.configPath))?.profiles.claude?.preferences).not.toHaveProperty('model');
    await vi.waitFor(() => expect(updates()).toHaveLength(2), { timeout: 2000 });
    const latest = JSON.stringify(updates().at(-1));
    expect(latest).toContain('✓ 跟随默认');
    expect(latest).not.toContain('✓ GPT-6 Astra');
    expect(latest).not.toContain('✓ GPT-5.6 Sol');

    // Clicking an already-selected model still repairs an old card's highlight.
    await h.dispatch({ cmd: 'model.select', arg: 'default' });
    await vi.waitFor(() => expect(updates()).toHaveLength(3), { timeout: 2000 });
    expect(JSON.stringify(updates().at(-1))).toContain('✓ 跟随默认');

  });

  it('persists effort clicks, rejects stale/unsupported choices, and refreshes highlights', async () => {
    const h = await createHarness();
    h.controls.profileConfig.agentKind = 'codex';
    h.controls.profileConfig.codex = { binaryPath: 'codex', codexHome: h.tmp.root };
    h.controls.profileConfig.preferences.model = 'model-a';
    await writeFile(join(h.tmp.root, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'model-a', visibility: 'list', default_reasoning_level: 'high', supported_reasoning_levels: [
        { effort: 'high' }, { effort: 'ultra' },
      ] },
      { slug: 'model-b', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [
        { effort: 'medium' }, { effort: 'high' },
      ] },
    ] }));
    await saveRootConfig(createRootConfig('claude', h.controls.profileConfig), h.controls.configPath);
    const channel = h.channel as unknown as Parameters<typeof sendManagedCard>[0];
    const card = modelCard('codex', 'model-a', false, h.tmp.root) as {
      body: { elements: Array<{ behaviors?: Array<{ value: Record<string, unknown> }> }> };
    };
    const click = card.body.elements.flatMap((element) => element.behaviors ?? [])
      .find((behavior) => behavior.value.arg === 'model-a ultra')!.value;
    await sendManagedCard(channel, 'oc_group', card);
    await h.dispatch(click);
    expect(h.controls.profileConfig.preferences.reasoningEffort).toBeUndefined();
    h.controls.profileConfig.access.admins = ['ou_operator'];
    await saveRootConfig(createRootConfig('claude', h.controls.profileConfig), h.controls.configPath);
    await h.dispatch(click);
    expect((await loadRootConfig(h.controls.configPath))?.profiles.claude?.preferences.reasoningEffort).toBe('ultra');
    const updates = () => h.channel.rawClient.requests.filter((request) => request.method === 'cardkit.v1.card.update');
    expect(updates()).toHaveLength(0);
    await vi.waitFor(() => expect(JSON.stringify(updates())).toContain('✓ ultra'), { timeout: 2000 });

    await h.dispatch({ cmd: 'model.select', arg: 'model-b' });
    expect(h.controls.profileConfig.preferences.reasoningEffort).toBe('medium');
    await h.dispatch(click); // An old model-a button must not apply to model-b.
    expect(h.controls.profileConfig.preferences.reasoningEffort).toBe('medium');
    await h.dispatch({ cmd: 'model.effort', arg: 'model-b ultra' });
    expect(h.controls.profileConfig.preferences.reasoningEffort).toBe('medium');
    await h.dispatch({ cmd: 'model.effort', arg: 'model-b high' });
    expect(h.controls.profileConfig.preferences.reasoningEffort).toBe('high');
    await vi.waitFor(() => expect(JSON.stringify(updates().at(-1))).toContain('✓ high'), { timeout: 2000 });
    expect(JSON.stringify(updates().at(-1))).not.toContain('model-b ultra');

    await h.dispatch({ cmd: 'model.effort', arg: 'model-b default' });
    expect((await loadRootConfig(h.controls.configPath))?.profiles.claude?.preferences).not.toHaveProperty('reasoningEffort');
    await vi.waitFor(() => expect(JSON.stringify(updates().at(-1))).toContain('✓ 跟随 CLI 默认'), { timeout: 2000 });
  });

  it('runs built-in command callbacks only when the bridge token verifies', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop'),
    });

    expect(activeRun.stopped).toBe(true);

    const deniedRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', deniedRun);
    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop', { operatorOpenId: 'ou_other' }),
    });

    expect(deniedRun.stopped).toBe(false);
  });

  it('forwards signed bridge callbacks after the original run has completed without leaking auth fields', async () => {
    const h = await createHarness();
    await h.dispatch(
      {
        __bridge_cb: true,
        bridge_token: h.token('agent_callback', { nonce: 'nonce-agent' }),
        choice: 'a',
      },
      { note: 'from form' },
    );

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a","form_value":{"note":"from form"}}');
    expect(queued[0]?.chatType).toBe('group');
  });

  it('drops legacy Claude callback markers before command dispatch', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __claude_cb: true,
      cmd: 'stop',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });

  it('scopes topic-group callbacks by the carrier message thread_id', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    // The dispatcher must read items[0].thread_id from the raw message get to
    // compose the `${chatId}:${threadId}` scope. A regression here (e.g. using
    // channel.fetchMessage, whose normalized shape drops thread_id) would fall
    // back to the bare chatId and route the click into the wrong session.
    h.channel.rawThreadIds.set('om_fake_1', 'th_topic');
    h.activeRuns.register('oc_group:th_topic', h.agent.run({ runId: 'run-active', prompt: 'running' }));

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { nonce: 'nonce-topic', scope: 'oc_group:th_topic' }),
      choice: 'a',
    });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    const queued = h.pending.cancel('oc_group:th_topic');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a"}');
  });

  it('rejects bridge callbacks when callback auth is unavailable', async () => {
    const h = await createHarness({ callbackAuth: false });
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __bridge_cb: true,
      choice: 'unsafe',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });
});

type Harness = {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: FakeAgentAdapter;
  controls: Controls;
  pending: PendingQueue;
  auth: CallbackAuth;
  dispatch(value: Record<string, unknown>, formValue?: Record<string, unknown>): Promise<void>;
  token(
    action: string,
    overrides?: { operatorOpenId?: string; nonce?: string; scope?: string },
  ): string;
};

async function createHarness(
  opts: { callbackAuth?: boolean; chatMode?: 'p2p' | 'group' | 'topic' } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('callback-dispatch-test-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const store = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  const controls = {
    profile: 'claude',
    profileConfig: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'] },
    }),
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'] },
    }),
    processId: 'proc-1',
  } satisfies Controls;
  let nonce = 'nonce-stop';
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
    now: () => 1000,
    createNonce: () => nonce,
  });
  const chatModeCache = {
    resolve: async () => opts.chatMode ?? 'group',
  } as unknown as ChatModeCache;
  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), store.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    activeRuns,
    agent,
    controls,
    pending,
    auth,
    token: (action, overrides = {}) => {
      nonce = overrides.nonce ?? `nonce-${action}`;
      return auth.sign({
        runId: 'run-active',
        scope: overrides.scope ?? 'oc_group',
        chatId: 'oc_group',
        operatorOpenId: overrides.operatorOpenId ?? 'ou_operator',
        action,
        policyFingerprint: 'fp-1',
        ttlMs: 60_000,
      });
    },
    dispatch: (value, formValue) =>
      handleCardAction({
        channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
        evt: cardEvent(value, formValue),
        sessions,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
        ...(opts.callbackAuth === false ? {} : { callbackAuth: auth }),
        callbackPolicyFingerprint: 'fp-1',
      }),
  };
}

function cardEvent(
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
): CardActionEvent {
  return {
    action: { value },
    chatId: 'oc_group',
    messageId: 'om_fake_1',
    operator: {
      openId: 'ou_operator',
      name: 'Operator',
    },
    raw: formValue ? { action: { form_value: formValue } } : undefined,
  } as unknown as CardActionEvent;
}
