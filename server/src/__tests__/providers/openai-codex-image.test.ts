import { describe, expect, it } from 'vitest';
import { toCodexResponsesInput } from '../../providers/openai-codex.js';

describe('OpenAI Codex image translation', () => {
  it('converts chat image_url blocks to Responses input_image blocks', () => {
    expect(toCodexResponsesInput([{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
      ],
    }])).toEqual([{
      role: 'user',
      content: [
        { type: 'input_text', text: 'describe this' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
      ],
    }]);
  });
});
