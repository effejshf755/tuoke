const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_RESPONSES_URL = `${CODEX_BASE_URL}/responses`;
import { getDb } from '../db/index.js';
import { contentToString } from '../lib/content.js';
import { decrypt } from '../lib/crypto.js';
import { proxyFetch } from '../lib/proxy.js';
import { recordCodexUsage } from '../services/codex-usage.js';
import type {
    ChatMessage,
    ChatCompletionResponse,
    ChatCompletionChunk,
  } from '@freellmapi/shared/types.js';
  
  import { BaseProvider } from './base.js';

  function redactSensitiveText(value: string): string {
    return value
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/("?(?:access_token|refresh_token)"?\s*[:=]\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
      .slice(0, 2_000);
  }

  function describeFetchError(error: unknown): string {
    const topLevel = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error
      ? (error as Error & { cause?: unknown }).cause
      : undefined;
    const causeMessage = cause instanceof Error ? cause.message : cause ? String(cause) : '';
    const causeCode = cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code?: unknown }).code ?? '')
      : '';

    return redactSensitiveText(
      [topLevel, causeCode && `code=${causeCode}`, causeMessage]
        .filter(Boolean)
        .join(' | '),
    );
  }

  interface CodexSseEvent {
    type: string;
    data: any;
  }

  type CodexTrackedError = Error & { codexAccountDbId?: number; codexStatus?: number };

  function trackedError(error: Error, accountDbId: number, status?: number): CodexTrackedError {
    const tracked = error as CodexTrackedError;
    tracked.codexAccountDbId = accountDbId;
    tracked.codexStatus = status;
    return tracked;
  }

  function authenticationFailure(error: unknown): boolean {
    const tracked = error as CodexTrackedError;
    return tracked?.codexStatus === 401 || tracked?.codexStatus === 403
      || /unauthori[sz]ed|authentication|invalid token|expired token/i.test(tracked?.message ?? '');
  }

  function quotaExhaustionFailure(error: unknown): boolean {
    const tracked = error as CodexTrackedError;
    return tracked?.codexStatus === 429
      && /usage_limit_reached|usage limit has been reached|quota|limit reached/i.test(tracked?.message ?? '');
  }

  function estimatedInputTokens(messages: ChatMessage[]): number {
    return Math.ceil(JSON.stringify(messages).length / 4);
  }

  type CodexResponsesInputItem =
    | { role: 'system' | 'user' | 'assistant'; content: string }
    | { type: 'function_call'; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string };

  /**
   * Translate OpenAI Chat Completions history into Responses API input items.
   * Assistant tool-call turns legitimately use content=null, but the Codex
   * Responses endpoint rejects null content and expects tool calls/results as
   * dedicated function_call and function_call_output items.
   */
  export function toCodexResponsesInput(messages: ChatMessage[]): CodexResponsesInputItem[] {
    const input: CodexResponsesInputItem[] = [];

    for (const message of messages) {
      const content = contentToString(message.content);

      if (message.role === 'tool') {
        if (message.tool_call_id) {
          input.push({
            type: 'function_call_output',
            call_id: message.tool_call_id,
            output: content,
          });
        }
        continue;
      }

      const toolCalls = message.role === 'assistant' ? (message.tool_calls ?? []) : [];
      if (content || toolCalls.length === 0) {
        input.push({
          role: message.role,
          content,
        });
      }

      for (const call of toolCalls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
    }

    return input;
  }

  async function* readCodexSse(res: Response): AsyncGenerator<CodexSseEvent> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Codex API returned no response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          const lines = block.split('\n');
          const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? '';
          const rawData = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!rawData) continue;
          if (rawData === '[DONE]') return;

          try {
            const data = JSON.parse(rawData);
            yield { type: String(data?.type ?? eventName), data };
          } catch {
            // Ignore non-JSON SSE keepalive events.
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* upstream already closed */ });
    }
  }
  
  function getAvailableCodexAccount(routeToken?: string, modelId?: string) {
    const match = /^codex-account:(\d+)$/.exec(routeToken ?? '');
    const selectedAccountId = match ? Number(match[1]) : null;
    const row = getDb().prepare(`
      SELECT a.*
      FROM codex_oauth_accounts a
      WHERE a.enabled = 1
        AND a.status IN ('healthy', 'unknown')
        AND (a.cooldown_until IS NULL OR a.cooldown_until <= datetime('now'))
        AND (
          a.quota_remaining_percent IS NULL
          OR a.quota_remaining_percent > 0
          OR (a.quota_reset_at IS NOT NULL AND datetime(a.quota_reset_at) <= datetime('now'))
        )
        AND (? IS NULL OR a.id = ?)
        AND (
          ? IS NULL OR EXISTS (
            SELECT 1 FROM codex_oauth_account_models am
            WHERE am.account_id = a.id AND am.model_id = ? AND am.enabled = 1
          )
        )
      ORDER BY a.last_used_at ASC, a.id ASC
      LIMIT 1
    `).get(selectedAccountId, selectedAccountId, modelId ?? null, modelId ?? null);
  
    if (!row) {
      throw new Error('No Codex account available');
    }
  
    return row as any;
  }
  function getCodexAccessToken(routeToken?: string, modelId?: string) {
    const account = getAvailableCodexAccount(routeToken, modelId);
    let accessToken: string;
    try {
      accessToken = decrypt(
        account.access_token_encrypted,
        account.access_token_iv,
        account.access_token_auth_tag,
      );
    } catch (error) {
      throw trackedError(error instanceof Error ? error : new Error(String(error)), account.id);
    }
  
    return {
      account,
      accessToken,
    };
  }

  export class OpenAICodexProvider extends BaseProvider {
    platform = 'openai-codex' as any;
    name = 'OpenAI Codex';

    private async requestResponses(
      messages: ChatMessage[],
      modelId: string,
      routeToken?: string,
    ): Promise<{ response: Response; accountDbId: number }> {
      const { account, accessToken } = getCodexAccessToken(routeToken, modelId);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (account.account_id) {
        headers['ChatGPT-Account-Id'] = String(account.account_id);
      }

      console.info(`[OpenAICodexProvider] request url=${CODEX_RESPONSES_URL}`);

      let res: Response;
      try {
        res = await proxyFetch(CODEX_RESPONSES_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            input: toCodexResponsesInput(messages),
            store: false,
            stream: true,
          }),
        }, this.platform, 'chat');
      } catch (error) {
        const message = describeFetchError(error);
        console.error(
          `[OpenAICodexProvider] request failed url=${CODEX_RESPONSES_URL} status=network_error error=${message}`,
        );
        throw trackedError(new Error(`Codex network error at ${CODEX_RESPONSES_URL}: ${message}`), account.id);
      }

      if (!res.ok) {
        const err = redactSensitiveText(await res.text());
        const message = err || res.statusText || 'Unknown upstream error';
        console.error(
          `[OpenAICodexProvider] upstream error url=${CODEX_RESPONSES_URL} status=${res.status} error=${message}`,
        );
        throw trackedError(new Error(`Codex API error ${res.status} at ${CODEX_RESPONSES_URL}: ${message}`), account.id, res.status);
      }

      return { response: res, accountDbId: account.id };
    }
  
  
    async chatCompletion(
        _apiKey: string,
        _messages: ChatMessage[],
        _modelId: string,
        _options?: any,
        _quotaContext?: any,
      ): Promise<ChatCompletionResponse> {
      
        let accountDbId: number | null = null;
        try {
        const requested = await this.requestResponses(_messages, _modelId, _apiKey);
        const res = requested.response;
        accountDbId = requested.accountDbId;
        let responseId = `codex-${Date.now()}`;
        let outputText = '';
        let finalResponse: any;

        for await (const event of readCodexSse(res)) {
          if (event.type === 'response.created' && event.data?.response?.id) {
            responseId = String(event.data.response.id);
          } else if (event.type === 'response.output_text.delta' && typeof event.data?.delta === 'string') {
            outputText += event.data.delta;
          } else if (event.type === 'response.completed') {
            finalResponse = event.data?.response ?? event.data;
            if (finalResponse?.id) responseId = String(finalResponse.id);
          } else if (event.type === 'response.failed' || event.type === 'error') {
            const message = event.data?.response?.error?.message
              ?? event.data?.error?.message
              ?? event.data?.message
              ?? 'Codex stream failed';
            throw new Error(`Codex API stream error: ${redactSensitiveText(String(message))}`);
          }
        }

        const usage = finalResponse?.usage;

          const fallbackInputTokens = estimatedInputTokens(_messages);
          const fallbackOutputTokens = Math.ceil(outputText.length / 4);
          const completion: ChatCompletionResponse = {
            id: responseId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: _modelId,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: outputText },
              finish_reason: 'stop',
            }],
            usage: usage ? {
              prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
              completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
              total_tokens: usage.total_tokens
                ?? ((usage.input_tokens ?? usage.prompt_tokens ?? 0) + (usage.output_tokens ?? usage.completion_tokens ?? 0)),
            } : {
              prompt_tokens: fallbackInputTokens,
              completion_tokens: fallbackOutputTokens,
              total_tokens: fallbackInputTokens + fallbackOutputTokens,
            },
          };
          recordCodexUsage({
            accountDbId,
            modelId: _modelId,
            success: true,
            inputTokens: completion.usage.prompt_tokens,
            outputTokens: completion.usage.completion_tokens,
          });
          return completion;
        } catch (error) {
          const tracked = error as CodexTrackedError;
          const id = accountDbId ?? tracked.codexAccountDbId;
          if (id) recordCodexUsage({
            accountDbId: id,
            modelId: _modelId,
            success: false,
            error: redactSensitiveText(tracked.message ?? String(error)),
            authenticationFailure: authenticationFailure(error),
            quotaExhausted: quotaExhaustionFailure(error),
          });
          throw error;
        }
      }
  
  
    async *streamChatCompletion(
      _apiKey: string,
      _messages: ChatMessage[],
      _modelId: string,
      _options?: any,
      _quotaContext?: any,
    ): AsyncGenerator<ChatCompletionChunk> {
      let accountDbId: number | null = null;
      let recorded = false;
      let outputCharacters = 0;
      let finalUsage: any;
      try {
      const requested = await this.requestResponses(_messages, _modelId, _apiKey);
      const res = requested.response;
      accountDbId = requested.accountDbId;
      const created = Math.floor(Date.now() / 1000);
      let responseId = `codex-${Date.now()}`;

      yield {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model: _modelId,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      };

      for await (const event of readCodexSse(res)) {
        if (event.type === 'response.created' && event.data?.response?.id) {
          responseId = String(event.data.response.id);
        } else if (event.type === 'response.output_text.delta' && typeof event.data?.delta === 'string') {
          outputCharacters += event.data.delta.length;
          yield {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model: _modelId,
            choices: [{ index: 0, delta: { content: event.data.delta }, finish_reason: null }],
          };
        } else if (event.type === 'response.completed') {
          finalUsage = event.data?.response?.usage ?? event.data?.usage;
        } else if (event.type === 'response.failed' || event.type === 'error') {
          const message = event.data?.response?.error?.message
            ?? event.data?.error?.message
            ?? event.data?.message
            ?? 'Codex stream failed';
          throw new Error(`Codex API stream error: ${redactSensitiveText(String(message))}`);
        }
      }

      recordCodexUsage({
        accountDbId,
        modelId: _modelId,
        success: true,
        inputTokens: finalUsage?.input_tokens ?? finalUsage?.prompt_tokens ?? estimatedInputTokens(_messages),
        outputTokens: finalUsage?.output_tokens ?? finalUsage?.completion_tokens ?? Math.ceil(outputCharacters / 4),
      });
      recorded = true;

      yield {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model: _modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      } catch (error) {
        const tracked = error as CodexTrackedError;
        const id = accountDbId ?? tracked.codexAccountDbId;
        if (id) recordCodexUsage({
          accountDbId: id,
          modelId: _modelId,
          success: false,
          error: redactSensitiveText(tracked.message ?? String(error)),
          authenticationFailure: authenticationFailure(error),
          quotaExhausted: quotaExhaustionFailure(error),
        });
        recorded = true;
        throw error;
      } finally {
        if (accountDbId && !recorded) {
          recordCodexUsage({
            accountDbId,
            modelId: _modelId,
            success: false,
            error: 'Codex stream ended before completion',
          });
        }
      }
    }
  
  
    async validateKey(): Promise<boolean> {
      return true;
    }
  }
