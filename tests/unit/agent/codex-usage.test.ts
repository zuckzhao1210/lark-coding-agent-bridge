import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatCodexUsage,
  readCodexUsage,
} from '../../../src/session/codex-usage.js';

interface FakeCodex {
  dir: string;
  path: string;
  recordPath: string;
}

describe('Codex usage provider', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    })));
  });

  it('reads account limits and current-thread token usage through app-server', async () => {
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);

    const snapshot = await readCodexUsage({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: false,
      threadId: 'thread-123',
      timeoutMs: 5000,
    });

    expect(snapshot).toMatchObject({
      rateLimits: [{
        limitId: 'codex',
        planType: 'team',
        primary: { usedPercent: 42, windowDurationMins: 300 },
        secondary: { usedPercent: 11, windowDurationMins: 10080 },
      }],
      resetCreditsAvailable: 2,
      tokenSummary: { lifetimeTokens: 1_234_567 },
      threadUsage: {
        threadId: 'thread-123',
        groups: [{ model: 'gpt-5.6-sol', totalTokens: 1500 }],
      },
      unavailable: [],
    });

    const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as {
      argv: string[];
      codexHome?: string;
      requests: Array<{ method: string; params?: unknown }>;
    };
    expect(record.argv).toEqual(['app-server', '--listen', 'stdio://']);
    expect(record.codexHome).toBe(join(fake.dir, 'codex-home'));
    expect(record.requests).toMatchObject([
      { method: 'initialize' },
      { method: 'account/rateLimits/read', params: null },
      { method: 'account/usage/read', params: { threadId: 'thread-123' } },
    ]);

    const formatted = formatCodexUsage(snapshot, new Date('2027-01-15T00:00:00Z'));
    expect(formatted).toContain('5 小时窗口：已用 42%，剩余 58%');
    expect(formatted).toContain('1 周窗口：已用 11%，剩余 89%');
    expect(formatted).toContain('总 tokens：1,500');
    expect(formatted).toContain('账户累计 tokens：1,234,567');
  });

  it('returns partial data when one usage endpoint is unavailable', async () => {
    const fake = await createFakeCodex({ failTokenUsage: true });
    cleanup.push(fake.dir);

    const snapshot = await readCodexUsage({
      binary: fake.path,
      profileStateDir: fake.dir,
      timeoutMs: 5000,
    });

    expect(snapshot.rateLimits).toHaveLength(1);
    expect(snapshot.unavailable).toEqual(['token-usage']);
    expect(formatCodexUsage(snapshot)).toContain('部分数据暂不可用：token 统计');
  });
});

async function createFakeCodex(
  options: { failTokenUsage?: boolean } = {},
): Promise<FakeCodex> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-usage-test-'));
  const scriptPath = process.platform === 'win32' ? join(dir, 'codex-usage.mjs') : join(dir, 'codex');
  const path = process.platform === 'win32' ? join(dir, 'codex.cmd') : scriptPath;
  const recordPath = join(dir, 'record.json');
  const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const requests = [];
const recordPath = ${JSON.stringify(recordPath)};
const failTokenUsage = ${JSON.stringify(options.failTokenUsage === true)};
let persisted = false;

function persist() {
  if (persisted) return;
  persisted = true;
  writeFileSync(recordPath, JSON.stringify({
    argv: process.argv.slice(2),
    codexHome: process.env.CODEX_HOME,
    requests
  }, null, 2));
}

process.on('SIGTERM', () => {
  persist();
  process.exit(0);
});
process.on('exit', persist);

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  requests.push({ method: req.method, params: req.params });
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: req.id, result: {
      userAgent: 'fake-codex', codexHome: process.env.CODEX_HOME ?? '',
      platformFamily: 'unix', platformOs: 'linux'
    } }) + '\\n');
  } else if (req.method === 'account/rateLimits/read') {
    process.stdout.write(JSON.stringify({ id: req.id, result: {
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex', planType: 'team',
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1800000000 },
          secondary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: 1800600000 },
          credits: { hasCredits: true, unlimited: false, balance: '9.5' }
        }
      },
      rateLimitResetCredits: { availableCount: 2 }
    } }) + '\\n');
  } else if (req.method === 'account/usage/read') {
    if (failTokenUsage) {
      process.stdout.write(JSON.stringify({ id: req.id, error: {
        code: -32000, message: 'token usage unavailable'
      } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ id: req.id, result: {
        summary: { lifetimeTokens: 1234567, peakDailyTokens: 50000, currentStreakDays: 3 },
        dailyUsageBuckets: [{ startDate: '2027-01-14', tokens: 12000 }],
        threadUsage: {
          threadId: req.params.threadId,
          estimatedUsageCreditsMicros: 0,
          estimatedUsageUsdMicros: 12500,
          groups: [{
            model: 'gpt-5.6-sol', reasoningEffort: 'medium',
            inputTokens: 1000, cachedInputTokens: 200,
            netNewInputTokens: 800, outputTokens: 500,
            totalTokens: 1500, estimatedUsageCreditsMicros: 0,
            estimatedUsageUsdMicros: 12500
          }]
        }
      } }) + '\\n');
    }
  }
});
`;
  await writeFile(scriptPath, script, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await chmod(path, 0o755);
  }
  return { dir, path, recordPath };
}
