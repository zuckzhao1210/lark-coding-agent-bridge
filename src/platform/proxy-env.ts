import { spawnSync } from 'node:child_process';

export const PROXY_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

const AGENT_PROXY_PREFIX = 'LARK_CHANNEL_AGENT_';

function gsettingsString(value: string | undefined): string | undefined {
  const match = value?.match(/^'((?:\\.|[^'])*)'$/);
  return match?.[1]?.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function proxyUrl(host: string | undefined, port: string | undefined): string | undefined {
  if (!host || !port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return undefined;
  }
  try {
    const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return new URL(`http://${address}:${port}`).origin;
  } catch {
    return undefined;
  }
}

/** A null result means GNOME settings could not be read; {} means proxy is off. */
export function parseGnomeProxyEnvironment(output: string): Record<string, string> | null {
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = line.match(/^org\.gnome\.system\.proxy(?:\.(http|https))? ([\w-]+) (.+)$/);
    if (match) values.set(`${match[1] ?? 'root'}.${match[2]}`, match[3]!);
  }

  const mode = gsettingsString(values.get('root.mode'));
  if (mode === 'none') return {};
  if (mode !== 'manual') return null;

  const http = proxyUrl(gsettingsString(values.get('http.host')), values.get('http.port'));
  const https = proxyUrl(gsettingsString(values.get('https.host')), values.get('https.port'));
  const shared = values.get('root.use-same-proxy') === 'true';
  const env: Record<string, string> = {};
  if (http) env.HTTP_PROXY = http;
  if (shared && http) env.HTTPS_PROXY = http;
  else if (https) env.HTTPS_PROXY = https;

  const ignoreHosts = values.get('root.ignore-hosts')?.match(/'((?:\\.|[^'])*)'/g)
    ?.map((entry) => gsettingsString(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (ignoreHosts?.length) env.NO_PROXY = ignoreHosts.join(',');
  return env;
}

function currentGnomeProxyEnvironment(base: NodeJS.ProcessEnv): Record<string, string> | null {
  const desktop = base.XDG_CURRENT_DESKTOP ?? base.DESKTOP_SESSION ?? '';
  if (!/gnome|ubuntu/i.test(desktop) || process.platform !== 'linux') return null;
  const result = spawnSync('gsettings', ['list-recursively', 'org.gnome.system.proxy'], {
    encoding: 'utf8',
    timeout: 1_000,
    maxBuffer: 32 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return null;
  return parseGnomeProxyEnvironment(result.stdout);
}

export function agentProxyEnvName(name: (typeof PROXY_ENV_NAMES)[number]): string {
  return `${AGENT_PROXY_PREFIX}${name}`;
}

/** Capture only proxy-related values, under bridge-private names. */
export function captureAgentProxyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    PROXY_ENV_NAMES.flatMap((name) => {
      const value = env[name];
      return value ? [[agentProxyEnvName(name), value]] : [];
    }),
  );
}

/** Restore captured values to their standard names for an agent child only. */
export function buildAgentProcessEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of PROXY_ENV_NAMES) {
    const value = base[agentProxyEnvName(name)];
    if (value !== undefined) env[name] = value;
  }

  return env;
}

/** Resolve the desktop proxy at Codex launch, independently of daemon startup. */
export function buildCodexProcessEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = buildAgentProcessEnvironment(base);
  // A systemd daemon keeps its startup environment even when the user toggles
  // the desktop proxy. Read GNOME's live setting for each new agent process.
  const systemProxy = currentGnomeProxyEnvironment(base);
  if (systemProxy !== null) {
    for (const name of PROXY_ENV_NAMES) delete env[name];
    Object.assign(env, systemProxy);
  }
  return env;
}

export function serializeAgentProxyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const captured = captureAgentProxyEnvironment(env);
  const lines = Object.entries(captured).map(
    ([name, value]) => `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  );
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
