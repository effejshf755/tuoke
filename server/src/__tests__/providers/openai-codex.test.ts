import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { codexCachedInputTokens, toCodexResponsesInput } from '../../providers/openai-codex.js';

describe('toCodexResponsesInput', () => {
  it('reads cached input tokens from supported Codex usage shapes', () => {
    expect(codexCachedInputTokens({ input_tokens_details: { cached_tokens: 120 } })).toBe(120);
    expect(codexCachedInputTokens({ prompt_tokens_details: { cached_tokens: 80 } })).toBe(80);
    expect(codexCachedInputTokens({ cached_input_tokens: 40 })).toBe(40);
    expect(codexCachedInputTokens({})).toBe(0);
  });
  it('never forwards null message content', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: null },
    ];

    expect(toCodexResponsesInput(messages)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '' },
    ]);
  });

  it('converts assistant tool calls and tool results to Responses input items', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: null },
    ];

    expect(toCodexResponsesInput(messages)).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '',
      },
    ]);
  });

  it('flattens array content and preserves assistant text before tool calls', () => {
    const messages: ChatMessage[] = [{
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }],
      tool_calls: [{
        id: 'call_2',
        type: 'function',
        function: { name: 'finish', arguments: '{}' },
      }],
    }];

    expect(toCodexResponsesInput(messages)).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'working' }] },
      {
        type: 'function_call',
        call_id: 'call_2',
        name: 'finish',
        arguments: '{}',
      },
    ]);
  });

  it('uses output_text for array-form assistant history', () => {
    expect(toCodexResponsesInput([
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ])).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'question' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ]);
  });
});
