import type { AgentRunOptions } from '../agent/types';

/** A deliberately non-secret capability passed only to a running agent. */
export interface CardInteractionContext {
  scope: string;
  chatId: string;
  operatorOpenId: string;
  policyFingerprint: string;
}

export const CARD_INTERACTION_CONTEXT_ENV = 'LARK_CHANNEL_CARD_CONTEXT';

export function buildCardInteractionEnv(
  context: AgentRunOptions['cardInteractionContext'],
): NodeJS.ProcessEnv {
  if (!context) return {};
  return { [CARD_INTERACTION_CONTEXT_ENV]: JSON.stringify(context) };
}

export function readCardInteractionContext(
  raw = process.env[CARD_INTERACTION_CONTEXT_ENV],
): CardInteractionContext | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<CardInteractionContext>;
    if (
      typeof value.scope !== 'string' || !value.scope ||
      typeof value.chatId !== 'string' || !value.chatId ||
      typeof value.operatorOpenId !== 'string' || !value.operatorOpenId ||
      typeof value.policyFingerprint !== 'string' || !value.policyFingerprint
    ) return undefined;
    return {
      scope: value.scope,
      chatId: value.chatId,
      operatorOpenId: value.operatorOpenId,
      policyFingerprint: value.policyFingerprint,
    };
  } catch {
    return undefined;
  }
}
