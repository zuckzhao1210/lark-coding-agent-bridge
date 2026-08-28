import { join } from 'node:path';
import { spawnProcess } from '../../platform/spawn';
import { CallbackAuth } from '../../card/callback-auth';
import { CallbackNonceStore } from '../../card/callback-store';
import { readCardInteractionContext } from '../../card/agent-context';
import { resolveAppPaths } from '../../config/app-paths';
import { runtimeProfileConfig, loadRootConfig } from '../../config/profile-store';
import { resolveAppSecret } from '../../config/secret-resolver';

type JsonRecord = Record<string, unknown>;

export interface CardSendOptions {
  card: string;
  ttlMinutes?: string;
}

export function prepareCardForCallbacks(
  card: unknown,
  sign: () => string,
): { card: JsonRecord; callbacks: number } {
  if (!isRecord(card) || card.schema !== '2.0') {
    throw new Error('card must be a CardKit 2.0 JSON object (schema: "2.0")');
  }

  let callbacks = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;

    if (Array.isArray(node.behaviors)) {
      for (const behavior of node.behaviors) {
        if (!isRecord(behavior) || behavior.type !== 'callback') continue;
        if (behavior.value !== undefined && !isRecord(behavior.value)) {
          throw new Error('each callback behavior.value must be a JSON object');
        }
        behavior.value = {
          ...(isRecord(behavior.value) ? behavior.value : {}),
          __bridge_cb: true,
          bridge_token: sign(),
        };
        callbacks++;
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(card);
  return { card, callbacks };
}

export async function runCardSend(opts: CardSendOptions): Promise<void> {
  const context = readCardInteractionContext();
  if (!context) {
    throw new Error('card send is available only inside an active lark-channel agent run');
  }
  const ttlMs = parseTtlMs(opts.ttlMinutes);
  let card: unknown;
  try {
    card = JSON.parse(opts.card);
  } catch {
    throw new Error('--card must be valid JSON');
  }

  const profile = process.env.LARK_CHANNEL_PROFILE;
  if (!profile) throw new Error('LARK_CHANNEL_PROFILE is missing');
  const appPaths = resolveAppPaths({ rootDir: process.env.LARK_CHANNEL_HOME, profile });
  const root = await loadRootConfig(appPaths.configFile);
  if (!root) throw new Error('bridge config was not found');
  const cfg = runtimeProfileConfig(root, appPaths.profile);
  const appSecret = await resolveAppSecret(cfg, appPaths);
  const nonceStore = new CallbackNonceStore(join(appPaths.profileDir, 'callback-nonces.json'));
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: appSecret }],
    nonceStore,
  });
  const prepared = prepareCardForCallbacks(card, () =>
    auth.sign({
      runId: process.env.LARK_CHANNEL_RUN_ID ?? '',
      scope: context.scope,
      chatId: context.chatId,
      operatorOpenId: context.operatorOpenId,
      action: 'agent_callback',
      policyFingerprint: context.policyFingerprint,
      ttlMs,
    }),
  );
  if (prepared.callbacks === 0) {
    throw new Error('card contains no callback behavior; use a normal lark-cli send for display-only cards');
  }
  const payload = {
    receive_id: context.chatId,
    msg_type: 'interactive',
    content: JSON.stringify(prepared.card),
  };
  await execLarkCli([
    'api',
    'POST',
    '--as',
    'bot',
    '/open-apis/im/v1/messages',
    '--params',
    JSON.stringify({ receive_id_type: 'chat_id' }),
    '--data',
    JSON.stringify(payload),
  ]);
  console.log(`sent CardKit 2.0 card with ${prepared.callbacks} signed callback(s)`);
}

function parseTtlMs(raw: string | undefined): number {
  if (raw === undefined) return 24 * 60 * 60 * 1000;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) {
    throw new Error('--ttl-minutes must be an integer from 1 to 10080');
  }
  return minutes * 60 * 1000;
}

function execLarkCli(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('lark-cli', args, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lark-cli failed with exit code ${code ?? 'unknown'}`));
    });
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

