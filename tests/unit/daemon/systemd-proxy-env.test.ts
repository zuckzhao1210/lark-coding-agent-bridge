import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  spawnSync: vi.fn((_bin: string, _args: string[]) => ({ status: 0, stdout: '', stderr: '' })),
  writeFile: vi.fn(async () => undefined),
  writeFileAtomic: vi.fn(async () => undefined),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: mocks.spawnSync,
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
}));

vi.mock('../../../src/platform/atomic-write', () => ({
  writeFileAtomic: mocks.writeFileAtomic,
}));

const { getServiceAdapter } = await import('../../../src/daemon/service-adapter');
const { agentProxyEnvPath, systemdUnitName } = await import('../../../src/daemon/paths');
const { buildUnit } = await import('../../../src/daemon/systemd');
const {
  PROXY_ENV_NAMES,
  agentProxyEnvName,
  buildAgentProcessEnvironment,
  buildCodexProcessEnvironment,
  serializeAgentProxyEnvironment,
} = await import('../../../src/platform/proxy-env');

const managedEnvNames = [
  ...PROXY_ENV_NAMES,
  ...PROXY_ENV_NAMES.map((name) => agentProxyEnvName(name)),
];
const realPlatform = process.platform;
const savedEnv = Object.fromEntries(managedEnvNames.map((name) => [name, process.env[name]]));

function forcePlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function systemctlCalls(): string[][] {
  return mocks.spawnSync.mock.calls
    .filter(([bin]) => bin === 'systemctl')
    .map(([, args]) => args);
}

describe('systemd agent proxy environment sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    forcePlatform('linux');
    for (const name of managedEnvNames) delete process.env[name];
  });

  afterEach(() => {
    for (const name of managedEnvNames) {
      const value = savedEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  afterAll(() => {
    forcePlatform(realPlatform);
  });

  it('stores current proxy values under bridge-private names', () => {
    const serialized = serializeAgentProxyEnvironment({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      no_proxy: '127.0.0.1,localhost',
    });

    expect(serialized).toBe(
      'LARK_CHANNEL_AGENT_HTTP_PROXY="http://127.0.0.1:7890"\n' +
        'LARK_CHANNEL_AGENT_no_proxy="127.0.0.1,localhost"\n',
    );
  });

  it('restores private values only in the agent child environment', () => {
    const env = buildAgentProcessEnvironment({
      LARK_CHANNEL_AGENT_HTTPS_PROXY: 'http://127.0.0.1:7890',
      PATH: '/usr/bin',
    });

    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('follows GNOME proxy changes for each new agent without restarting the daemon', () => {
    let mode = 'manual';
    mocks.spawnSync.mockImplementation((bin: string) => {
      if (bin !== 'gsettings') return { status: 0, stdout: '', stderr: '' };
      return {
        status: 0,
        stdout: [
          `org.gnome.system.proxy mode '${mode}'`,
          'org.gnome.system.proxy use-same-proxy true',
          "org.gnome.system.proxy.http host '127.0.0.1'",
          'org.gnome.system.proxy.http port 7890',
          "org.gnome.system.proxy.https host '127.0.0.1'",
          'org.gnome.system.proxy.https port 7890',
          "org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.1']",
        ].join('\n'),
        stderr: '',
      };
    });
    const base = {
      XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
      LARK_CHANNEL_AGENT_HTTPS_PROXY: 'http://127.0.0.1:8888',
      LARK_CHANNEL_AGENT_http_proxy: 'http://127.0.0.1:8888',
    };

    const enabled = buildCodexProcessEnvironment(base);
    expect(enabled.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(enabled.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(enabled.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(enabled.LARK_CHANNEL_AGENT_HTTPS_PROXY).toBe('http://127.0.0.1:8888');

    mode = 'none';
    const disabled = buildCodexProcessEnvironment(base);
    expect(PROXY_ENV_NAMES.every((name) => disabled[name] === undefined)).toBe(true);
    expect(buildAgentProcessEnvironment(base).HTTPS_PROXY).toBe('http://127.0.0.1:8888');

    mode = 'manual';
    expect(buildCodexProcessEnvironment({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }).HTTPS_PROXY)
      .toBe('http://127.0.0.1:7890');
  });

  it('falls back to captured proxy values if GNOME settings are unavailable', () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'unavailable' });
    const env = buildCodexProcessEnvironment({
      XDG_CURRENT_DESKTOP: 'GNOME',
      LARK_CHANNEL_AGENT_HTTPS_PROXY: 'http://127.0.0.1:7890',
    });
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
  });

  it('keeps standard proxy variables out of the bridge service process', () => {
    const unit = buildUnit({
      nodePath: '/usr/bin/node',
      bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
      envPath: '/usr/bin',
      profile: 'codex',
      runArgs: ['run', '--profile', 'codex'],
      channelHome: '/tmp/lark-channel',
    });

    expect(unit).toContain(`EnvironmentFile=-${agentProxyEnvPath('codex')}`);
    expect(unit).toContain(`UnsetEnvironment=${PROXY_ENV_NAMES.join(' ')}`);
  });

  it('refreshes the proxy snapshot before restarting the service', async () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890';
    process.env.no_proxy = '127.0.0.1,localhost';

    await getServiceAdapter('codex')?.restart();

    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      agentProxyEnvPath('codex'),
      'LARK_CHANNEL_AGENT_HTTP_PROXY="http://127.0.0.1:7890"\n' +
        'LARK_CHANNEL_AGENT_no_proxy="127.0.0.1,localhost"\n',
    );
    expect(systemctlCalls()).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'restart', systemdUnitName('codex')],
    ]);
  });

  it('writes an empty snapshot when restarting without a proxy', async () => {
    await getServiceAdapter('codex')?.restart();

    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(agentProxyEnvPath('codex'), '');
    expect(systemctlCalls()).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'restart', systemdUnitName('codex')],
    ]);
  });

  it('does not restart when reloading the refreshed unit fails', async () => {
    mocks.spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: 'failed to reload unit',
    });

    const result = await getServiceAdapter('codex')?.restart();

    expect(result?.ok).toBe(false);
    expect(result?.stderr).toContain('failed to reload unit');
    expect(systemctlCalls()).toHaveLength(1);
  });
});
