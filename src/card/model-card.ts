import { modelLabel, normalizeModelSelection, supportedModels, supportedReasoningLevels, resolveReasoningEffortArg } from '../agent/models';
import type { AgentKind } from '../config/profile-schema';

/** Model buttons use the command dispatcher so admin checks apply to every click. */
export function modelCard(agentKind: AgentKind, model: string | undefined, saved = false, codexHome?: string, reasoningEffort?: string): object {
  const current = normalizeModelSelection(agentKind, model, codexHome);
  const levels = supportedReasoningLevels(agentKind, current, codexHome);
  const effort = resolveReasoningEffortArg(agentKind, current, reasoningEffort, codexHome);
  return {
    schema: '2.0',
    config: { summary: { content: '切换模型' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `${saved ? '✅ 模型设置已保存' : '🤖 切换模型'}\n\n当前模型：**${modelLabel(agentKind, current, codexHome)}**\n\n点击下方按钮切换。模型是 Profile 全局设置，从下一条消息开始生效。`,
        },
        { tag: 'markdown', content: '**模型**' },
        ...supportedModels(agentKind, codexHome).map((option) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: `${option.value === current ? '✓ ' : ''}${option.label}` },
          type: option.value === current ? 'primary' : 'default',
          behaviors: [{ type: 'callback', value: { cmd: 'model.select', arg: option.value } }],
        })),
        ...(agentKind === 'codex' ? [
          { tag: 'hr' },
          { tag: 'markdown', content: `**推理强度：${effort ?? '跟随 CLI 默认'}**\n` +
            (levels.length > 0 ? '选择后从下一条消息开始生效。' : '请先选择具体模型；若仍无选项，请运行 Codex CLI 刷新模型列表。') },
          ...(levels.length > 0 ? [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: `${!effort ? '✓ ' : ''}跟随 CLI 默认` },
              type: !effort ? 'primary' : 'default',
              behaviors: [{ type: 'callback', value: { cmd: 'model.effort', arg: `${current} default` } }],
            },
            ...levels.map((level) => ({
              tag: 'button',
              text: { tag: 'plain_text', content: `${level.effort === effort ? '✓ ' : ''}${level.effort}` },
              type: level.effort === effort ? 'primary' : 'default',
              ...(level.description ? { hover_tips: { tag: 'plain_text', content: level.description } } : {}),
              behaviors: [{ type: 'callback', value: { cmd: 'model.effort', arg: `${current} ${level.effort}` } }],
            })),
          ] : []),
        ] : []),
      ],
    },
  };
}
