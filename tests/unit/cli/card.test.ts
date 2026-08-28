import { describe, expect, it } from 'vitest';
import { prepareCardForCallbacks } from '../../../src/cli/commands/card.js';

describe('CardKit callback preparation', () => {
  it('signs every callback behavior while preserving button, selector, and form payloads', () => {
    let index = 0;
    const input = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'button', behaviors: [{ type: 'callback', value: { choice: 'a' } }] },
          { tag: 'select_static', behaviors: [{ type: 'callback', value: { field: 'priority' } }] },
          {
            tag: 'form',
            elements: [{ tag: 'button', behaviors: [{ type: 'callback', value: { submit: true } }] }],
          },
        ],
      },
    };

    const result = prepareCardForCallbacks(input, () => `token-${++index}`);

    expect(result.callbacks).toBe(3);
    const serialized = JSON.stringify(result.card);
    expect(serialized).toContain('"choice":"a"');
    expect(serialized).toContain('"field":"priority"');
    expect(serialized).toContain('"submit":true');
    expect(serialized).toContain('"bridge_token":"token-1"');
    expect(serialized).toContain('"bridge_token":"token-2"');
    expect(serialized).toContain('"bridge_token":"token-3"');
  });

  it('rejects non-CardKit and display-only cards', () => {
    expect(() => prepareCardForCallbacks({ schema: '1.0' }, () => 'token')).toThrow('CardKit 2.0');
    expect(() => prepareCardForCallbacks({ schema: '2.0', body: { elements: [] } }, () => 'token'))
      .not.toThrow();
  });
});

