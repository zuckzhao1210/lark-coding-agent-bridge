import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import {
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../platform/spawn';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface CodexRateLimitBucket {
  limitId?: string;
  limitName?: string;
  planType?: string;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance?: string;
  };
  spendControlReached?: boolean;
  rateLimitReachedType?: string;
}

export interface CodexTokenUsageGroup {
  model?: string;
  reasoningEffort?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  netNewInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedUsageCreditsMicros: number;
  estimatedUsageUsdMicros?: number;
}

export interface CodexUsageSnapshot {
  rateLimits: CodexRateLimitBucket[];
  resetCreditsAvailable?: number;
  tokenSummary?: {
    lifetimeTokens?: number;
    peakDailyTokens?: number;
    currentStreakDays?: number;
  };
  dailyUsageBuckets?: Array<{ startDate: string; tokens: number }>;
  threadUsage?: {
    threadId: string;
    estimatedUsageCreditsMicros: number;
    estimatedUsageUsdMicros?: number;
    groups: CodexTokenUsageGroup[];
  };
  unavailable: Array<'rate-limits' | 'token-usage'>;
}

export interface ReadCodexUsageOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  threadId?: string;
  timeoutMs?: number;
}

export class CodexUsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexUsageError';
  }
}

const DEFAULT_TIMEOUT_MS = 7000;

export async function readCodexUsage(
  options: ReadCodexUsageOptions,
): Promise<CodexUsageSnapshot> {
  const child = spawnCodexAppServer(options);
  const stderrChunks: Buffer[] = [];
  const unavailable: CodexUsageSnapshot['unavailable'] = [];
  const pending = new Set([2, 3]);
  let rateLimits: ReturnType<typeof normalizeRateLimitsResponse>;
  let tokenUsage: ReturnType<typeof normalizeTokenUsageResponse>;
  let settled = false;

  const result = await new Promise<CodexUsageSnapshot>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (kill: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rl.close();
      child.removeAllListeners('error');
      child.stdin.removeAllListeners('error');
      child.stderr.removeAllListeners('data');
      if (kill && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    };

    const fail = (err: unknown): void => {
      if (settled) return;
      cleanup(true);
      reject(new CodexUsageError(errorMessage(err), { cause: err }));
    };

    const finishIfReady = (): void => {
      if (settled || pending.size > 0) return;
      if (!rateLimits && !tokenUsage) {
        cleanup(true);
        reject(new CodexUsageError('Codex app-server did not return usage data'));
        return;
      }
      const snapshot: CodexUsageSnapshot = {
        rateLimits: rateLimits?.rateLimits ?? [],
        ...(rateLimits?.resetCreditsAvailable !== undefined
          ? { resetCreditsAvailable: rateLimits.resetCreditsAvailable }
          : {}),
        ...(tokenUsage?.tokenSummary ? { tokenSummary: tokenUsage.tokenSummary } : {}),
        ...(tokenUsage?.dailyUsageBuckets
          ? { dailyUsageBuckets: tokenUsage.dailyUsageBuckets }
          : {}),
        ...(tokenUsage?.threadUsage ? { threadUsage: tokenUsage.threadUsage } : {}),
        unavailable,
      };
      cleanup(true);
      resolve(snapshot);
    };

    timer = setTimeout(() => {
      fail(new Error(`Codex usage query timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.once('error', fail);
    child.stdin.once('error', fail);
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.once('exit', (code) => {
      if (settled) return;
      const detail = Buffer.concat(stderrChunks).toString('utf8').trim();
      fail(new Error(
        `Codex app-server exited before usage response: ${code ?? 'signal'}${detail ? `: ${detail}` : ''}`,
      ));
    });

    rl.on('line', (line) => {
      if (settled || !line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const response = recordValue(message);
      const id = numberValue(response?.id);
      if (id !== 2 && id !== 3) return;
      pending.delete(id);
      if (response?.error) {
        unavailable.push(id === 2 ? 'rate-limits' : 'token-usage');
      } else if (id === 2) {
        rateLimits = normalizeRateLimitsResponse(response?.result);
        if (!rateLimits) unavailable.push('rate-limits');
      } else {
        tokenUsage = normalizeTokenUsageResponse(response?.result);
        if (!tokenUsage) unavailable.push('token-usage');
      }
      finishIfReady();
    });

    const requests = [
      initializeRequest(),
      { method: 'account/rateLimits/read', id: 2, params: null },
      {
        method: 'account/usage/read',
        id: 3,
        params: options.threadId ? { threadId: options.threadId } : null,
      },
    ];
    try {
      child.stdin.write(
        `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
        (err) => {
          if (err) fail(err);
        },
      );
    } catch (err) {
      fail(err);
    }
  });

  await waitForChildExit(child, 250);
  return result;
}

export function formatCodexUsage(snapshot: CodexUsageSnapshot, now = new Date()): string {
  const lines = ['📊 **Codex 用量**'];
  const plans = [...new Set(snapshot.rateLimits.map((bucket) => bucket.planType).filter(Boolean))];
  if (plans.length > 0) lines.push(`套餐：${plans.map((plan) => escapeMd(plan as string)).join(' / ')}`);

  if (snapshot.rateLimits.length > 0) {
    lines.push('', '**限额窗口**');
    for (const bucket of snapshot.rateLimits) {
      const label = bucket.limitName ?? bucket.limitId;
      if (snapshot.rateLimits.length > 1 && label) lines.push(`• ${escapeMd(label)}`);
      for (const window of [bucket.primary, bucket.secondary]) {
        if (!window) continue;
        const remaining = Math.max(0, 100 - window.usedPercent);
        const reset = window.resetsAt
          ? `，${formatResetTime(window.resetsAt, now)}重置`
          : '';
        lines.push(
          `  - ${formatWindowDuration(window.windowDurationMins)}：已用 ${window.usedPercent}%，剩余 ${remaining}%${reset}`,
        );
      }
      if (bucket.rateLimitReachedType) {
        lines.push(`  - ⚠️ 当前受限：${escapeMd(bucket.rateLimitReachedType)}`);
      }
      if (bucket.spendControlReached) lines.push('  - ⚠️ 已达到消费控制上限');
      if (bucket.credits?.unlimited) {
        lines.push('  - Credits：无限');
      } else if (bucket.credits?.balance) {
        lines.push(`  - Credits：${escapeMd(bucket.credits.balance)}`);
      }
    }
  } else {
    lines.push('', '限额窗口：暂不可用');
  }

  if (snapshot.resetCreditsAvailable !== undefined && snapshot.resetCreditsAvailable > 0) {
    lines.push(`可用重置次数：${snapshot.resetCreditsAvailable}`);
  }

  if (snapshot.threadUsage) {
    const totals = sumThreadGroups(snapshot.threadUsage.groups);
    lines.push('', '**当前会话**');
    if (totals.totalTokens !== undefined) lines.push(`总 tokens：${formatNumber(totals.totalTokens)}`);
    const details = [
      numberDetail('输入', totals.inputTokens),
      numberDetail('缓存输入', totals.cachedInputTokens),
      numberDetail('净新增输入', totals.netNewInputTokens),
      numberDetail('输出', totals.outputTokens),
    ].filter(Boolean);
    if (details.length > 0) lines.push(details.join(' · '));
    const models = snapshot.threadUsage.groups
      .map((group) => [group.model, group.reasoningEffort].filter(Boolean).join(' / '))
      .filter(Boolean);
    if (models.length > 0) lines.push(`模型：${[...new Set(models)].map(escapeMd).join('、')}`);
    if (snapshot.threadUsage.estimatedUsageUsdMicros !== undefined) {
      lines.push(`估算费用：$${(snapshot.threadUsage.estimatedUsageUsdMicros / 1_000_000).toFixed(4)}`);
    }
  }

  if (snapshot.tokenSummary?.lifetimeTokens !== undefined) {
    lines.push('', `账户累计 tokens：${formatNumber(snapshot.tokenSummary.lifetimeTokens)}`);
  }
  const latestDaily = snapshot.dailyUsageBuckets?.at(-1);
  if (latestDaily) lines.push(`${escapeMd(latestDaily.startDate)}：${formatNumber(latestDaily.tokens)} tokens`);

  if (snapshot.unavailable.length > 0) {
    const labels = snapshot.unavailable.map((item) => item === 'rate-limits' ? '限额' : 'token 统计');
    lines.push('', `_部分数据暂不可用：${labels.join('、')}_`);
  }
  return lines.join('\n');
}

function spawnCodexAppServer(options: ReadCodexUsageOptions): CodexAppServerChild {
  const envOverrides: NodeJS.ProcessEnv = {};
  if (options.codexHome) {
    envOverrides.CODEX_HOME = options.codexHome;
  } else if (options.inheritCodexHome === false) {
    envOverrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  }
  return spawnProcess(options.binary, ['app-server', '--listen', 'stdio://'], {
    env: mergeProcessEnv(process.env, envOverrides),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CodexAppServerChild;
}

function initializeRequest(): object {
  return {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'lark-channel-bridge',
        title: 'Lark Channel Bridge',
        version: '0.7.0',
      },
      capabilities: null,
    },
  };
}

function normalizeRateLimitsResponse(input: unknown): {
  rateLimits: CodexRateLimitBucket[];
  resetCreditsAvailable?: number;
} | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const buckets: CodexRateLimitBucket[] = [];
  const byId = recordValue(raw.rateLimitsByLimitId ?? raw.rate_limits_by_limit_id);
  if (byId) {
    for (const [limitId, value] of Object.entries(byId)) {
      const bucket = normalizeRateLimitBucket(value, limitId);
      if (bucket) buckets.push(bucket);
    }
  }
  if (buckets.length === 0) {
    const bucket = normalizeRateLimitBucket(raw.rateLimits ?? raw.rate_limits);
    if (bucket) buckets.push(bucket);
  }
  const resetCredits = recordValue(raw.rateLimitResetCredits ?? raw.rate_limit_reset_credits);
  const available = numberValue(resetCredits?.availableCount ?? resetCredits?.available_count);
  return {
    rateLimits: buckets,
    ...(available !== undefined ? { resetCreditsAvailable: available } : {}),
  };
}

function normalizeRateLimitBucket(input: unknown, fallbackId?: string): CodexRateLimitBucket | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const credits = recordValue(raw.credits);
  const spendControlReached = booleanValue(raw.spendControlReached ?? raw.spend_control_reached);
  return {
    ...(stringValue(raw.limitId ?? raw.limit_id) ?? fallbackId
      ? { limitId: stringValue(raw.limitId ?? raw.limit_id) ?? fallbackId }
      : {}),
    ...(stringValue(raw.limitName ?? raw.limit_name)
      ? { limitName: stringValue(raw.limitName ?? raw.limit_name) }
      : {}),
    ...(stringValue(raw.planType ?? raw.plan_type)
      ? { planType: stringValue(raw.planType ?? raw.plan_type) }
      : {}),
    ...(normalizeRateLimitWindow(raw.primary) ? { primary: normalizeRateLimitWindow(raw.primary) } : {}),
    ...(normalizeRateLimitWindow(raw.secondary) ? { secondary: normalizeRateLimitWindow(raw.secondary) } : {}),
    ...(credits && booleanValue(credits.hasCredits ?? credits.has_credits) !== undefined
      && booleanValue(credits.unlimited) !== undefined
      ? {
          credits: {
            hasCredits: booleanValue(credits.hasCredits ?? credits.has_credits) as boolean,
            unlimited: booleanValue(credits.unlimited) as boolean,
            ...(stringValue(credits.balance) ? { balance: stringValue(credits.balance) } : {}),
          },
        }
      : {}),
    ...(spendControlReached !== undefined ? { spendControlReached } : {}),
    ...(stringValue(raw.rateLimitReachedType ?? raw.rate_limit_reached_type)
      ? { rateLimitReachedType: stringValue(raw.rateLimitReachedType ?? raw.rate_limit_reached_type) }
      : {}),
  };
}

function normalizeRateLimitWindow(input: unknown): CodexRateLimitWindow | undefined {
  const raw = recordValue(input);
  const usedPercent = numberValue(raw?.usedPercent ?? raw?.used_percent);
  if (usedPercent === undefined) return undefined;
  const duration = numberValue(raw?.windowDurationMins ?? raw?.window_minutes);
  const resetsAt = numberValue(raw?.resetsAt ?? raw?.resets_at);
  return {
    usedPercent,
    ...(duration !== undefined ? { windowDurationMins: duration } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function normalizeTokenUsageResponse(input: unknown): {
  tokenSummary?: CodexUsageSnapshot['tokenSummary'];
  dailyUsageBuckets?: CodexUsageSnapshot['dailyUsageBuckets'];
  threadUsage?: CodexUsageSnapshot['threadUsage'];
} | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const summary = recordValue(raw.summary);
  const tokenSummary = summary ? {
    ...(numberValue(summary.lifetimeTokens ?? summary.lifetime_tokens) !== undefined
      ? { lifetimeTokens: numberValue(summary.lifetimeTokens ?? summary.lifetime_tokens) }
      : {}),
    ...(numberValue(summary.peakDailyTokens ?? summary.peak_daily_tokens) !== undefined
      ? { peakDailyTokens: numberValue(summary.peakDailyTokens ?? summary.peak_daily_tokens) }
      : {}),
    ...(numberValue(summary.currentStreakDays ?? summary.current_streak_days) !== undefined
      ? { currentStreakDays: numberValue(summary.currentStreakDays ?? summary.current_streak_days) }
      : {}),
  } : undefined;
  const rawDailyUsageBuckets = raw.dailyUsageBuckets ?? raw.daily_usage_buckets;
  const dailyUsageBuckets = Array.isArray(rawDailyUsageBuckets)
    ? rawDailyUsageBuckets
        .map(normalizeDailyBucket)
        .filter((bucket): bucket is { startDate: string; tokens: number } => Boolean(bucket))
    : undefined;
  const threadUsage = normalizeThreadUsage(raw.threadUsage ?? raw.thread_usage);
  return {
    ...(tokenSummary ? { tokenSummary } : {}),
    ...(dailyUsageBuckets ? { dailyUsageBuckets } : {}),
    ...(threadUsage ? { threadUsage } : {}),
  };
}

function normalizeDailyBucket(input: unknown): { startDate: string; tokens: number } | undefined {
  const raw = recordValue(input);
  const startDate = stringValue(raw?.startDate ?? raw?.start_date);
  const tokens = numberValue(raw?.tokens);
  return startDate && tokens !== undefined ? { startDate, tokens } : undefined;
}

function normalizeThreadUsage(input: unknown): CodexUsageSnapshot['threadUsage'] | undefined {
  const raw = recordValue(input);
  const threadId = stringValue(raw?.threadId ?? raw?.thread_id);
  const credits = numberValue(raw?.estimatedUsageCreditsMicros ?? raw?.estimated_usage_credits_micros);
  if (!raw || !threadId || credits === undefined) return undefined;
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map(normalizeTokenGroup).filter((group): group is CodexTokenUsageGroup => Boolean(group))
    : [];
  const usd = numberValue(raw.estimatedUsageUsdMicros ?? raw.estimated_usage_usd_micros);
  return {
    threadId,
    estimatedUsageCreditsMicros: credits,
    ...(usd !== undefined ? { estimatedUsageUsdMicros: usd } : {}),
    groups,
  };
}

function normalizeTokenGroup(input: unknown): CodexTokenUsageGroup | undefined {
  const raw = recordValue(input);
  const credits = numberValue(raw?.estimatedUsageCreditsMicros ?? raw?.estimated_usage_credits_micros);
  if (!raw || credits === undefined) return undefined;
  const numeric = (camel: string, snake: string): number | undefined => numberValue(raw[camel] ?? raw[snake]);
  return {
    estimatedUsageCreditsMicros: credits,
    ...(stringValue(raw.model) ? { model: stringValue(raw.model) } : {}),
    ...(stringValue(raw.reasoningEffort ?? raw.reasoning_effort)
      ? { reasoningEffort: stringValue(raw.reasoningEffort ?? raw.reasoning_effort) }
      : {}),
    ...(numeric('inputTokens', 'input_tokens') !== undefined
      ? { inputTokens: numeric('inputTokens', 'input_tokens') }
      : {}),
    ...(numeric('cachedInputTokens', 'cached_input_tokens') !== undefined
      ? { cachedInputTokens: numeric('cachedInputTokens', 'cached_input_tokens') }
      : {}),
    ...(numeric('netNewInputTokens', 'net_new_input_tokens') !== undefined
      ? { netNewInputTokens: numeric('netNewInputTokens', 'net_new_input_tokens') }
      : {}),
    ...(numeric('outputTokens', 'output_tokens') !== undefined
      ? { outputTokens: numeric('outputTokens', 'output_tokens') }
      : {}),
    ...(numeric('totalTokens', 'total_tokens') !== undefined
      ? { totalTokens: numeric('totalTokens', 'total_tokens') }
      : {}),
    ...(numeric('estimatedUsageUsdMicros', 'estimated_usage_usd_micros') !== undefined
      ? { estimatedUsageUsdMicros: numeric('estimatedUsageUsdMicros', 'estimated_usage_usd_micros') }
      : {}),
  };
}

function sumThreadGroups(groups: CodexTokenUsageGroup[]): Partial<CodexTokenUsageGroup> {
  const keys = [
    'inputTokens',
    'cachedInputTokens',
    'netNewInputTokens',
    'outputTokens',
    'totalTokens',
  ] as const;
  const result: Partial<CodexTokenUsageGroup> = {};
  for (const key of keys) {
    const values = groups.map((group) => group[key]).filter((value): value is number => value !== undefined);
    if (values.length > 0) result[key] = values.reduce((sum, value) => sum + value, 0);
  }
  return result;
}

function numberDetail(label: string, value: number | undefined): string {
  return value === undefined ? '' : `${label} ${formatNumber(value)}`;
}

function formatWindowDuration(minutes: number | undefined): string {
  if (minutes === undefined) return '当前窗口';
  if (minutes % 10_080 === 0) return `${minutes / 10_080} 周窗口`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440} 天窗口`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${minutes} 分钟窗口`;
}

function formatResetTime(timestampSeconds: number, now: Date): string {
  const reset = new Date(timestampSeconds * 1000);
  const sameDay = reset.getFullYear() === now.getFullYear()
    && reset.getMonth() === now.getMonth()
    && reset.getDate() === now.getDate();
  return new Intl.DateTimeFormat('zh-CN', {
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(reset);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function escapeMd(value: string): string {
  return value.replace(/[\\`*_~]/g, '\\$&');
}

async function waitForChildExit(child: CodexAppServerChild, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
