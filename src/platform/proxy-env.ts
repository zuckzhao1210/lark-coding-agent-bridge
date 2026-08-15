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

export function serializeAgentProxyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const captured = captureAgentProxyEnvironment(env);
  const lines = Object.entries(captured).map(
    ([name, value]) => `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  );
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
