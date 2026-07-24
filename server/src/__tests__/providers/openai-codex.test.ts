import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { toCodexResponsesInput } from '../../providers/openai-codex.js';

describe('toCodexResponsesInput', () => {
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
      { role: 'assistant', content: 'working' },
      {
        type: 'function_call',
        call_id: 'call_2',
        name: 'finish',
        arguments: '{}',
      },
    ]);
  });
});
