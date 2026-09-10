import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ probe: vi.fn(), spawn: vi.fn() }));
vi.mock('../../../src/agent/preflight', () => ({ checkAgentAvailability: mocks.probe }));
vi.mock('../../../src/platform/spawn', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/platform/spawn')>(),
  spawnProcess: mocks.spawn,
}));
import { CodexAdapter } from '../../../src/agent/codex/adapter';

describe('Codex run preparation', () => {
  let adapter: CodexAdapter;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));
    mocks.probe.mockReset().mockResolvedValue({ ok: true, version: 'codex 1.0' });
    mocks.spawn.mockReset();
    adapter = new CodexAdapter({ binary: 'codex', profileStateDir: '/tmp/profile' });
  });
  afterEach(() => vi.useRealTimers());

  it('shares concurrent probes and checks again when the success expires', async () => {
    await Promise.all([adapter.prepareRun(), adapter.prepareRun(), adapter.prepareRun()]);
    await adapter.prepareRun();
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    await adapter.prepareRun();
    expect(mocks.probe).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed check or hide recovery', async () => {
    mocks.probe.mockResolvedValueOnce({
      ok: false, error: new Error('missing'), diagnostic: { code: 'agent-binary-not-found' },
    });
    await expect(adapter.prepareRun()).rejects.toThrow('codex binary check failed');
    await expect(adapter.prepareRun()).resolves.toBeUndefined();
    expect(mocks.probe).toHaveBeenCalledTimes(2);
  });

  it('clears an unexpected probe rejection for the next attempt', async () => {
    mocks.probe.mockRejectedValueOnce(new Error('probe failed'));
    await expect(adapter.prepareRun()).rejects.toThrow('probe failed');
    await expect(adapter.prepareRun()).resolves.toBeUndefined();
  });

  it('always probes for explicit diagnostics even within the cache lifetime', async () => {
    await adapter.prepareRun();
    await adapter.checkAvailability();
    expect(mocks.probe).toHaveBeenCalledTimes(2);
  });

  it.each(['error', 'exit'] as const)('invalidates after a child %s failure', async (event) => {
    await adapter.prepareRun();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 1, exitCode: null, signalCode: null, kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
    adapter.run({ runId: 'test', cwd: '/tmp', prompt: 'hi' });
    if (event === 'error') child.emit('error', new Error('missing binary'));
    else child.emit('exit', 1, null);
    await adapter.prepareRun();
    expect(mocks.probe).toHaveBeenCalledTimes(2);
  });
});
