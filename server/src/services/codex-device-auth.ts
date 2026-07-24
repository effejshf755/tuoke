import crypto from 'node:crypto';

import { getDb } from '../db/index.js';
import { proxyFetch } from '../lib/proxy.js';
import { discoverCodexModels, replaceCodexAccountModels } from './codex-model-discovery.js';
import { createCodexAccount } from './codex-oauth.js';
import { encryptCodexToken } from './codex-token.js';

const DEVICE_USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEVICE_CALLBACK_URL = 'https://auth.openai.com/deviceauth/callback';
const DEVICE_VERIFICATION_URL = 'https://auth.openai.com/codex/device';
const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const MAX_LOGIN_AGE_MS = 15 * 60 * 1000;

type DeviceSessionStatus = 'pending' | 'complete' | 'failed';
type UnknownRecord = Record<string, unknown>;

interface DeviceSession {
  id: string;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  createdAt: number;
  status: DeviceSessionStatus;
  importedAccountId?: number;
  accountId?: string | null;
  models?: string[];
  modelDiscoveryError?: string | null;
  error?: string;
}

interface DeviceCodeResponse {
  device_auth_id: string;
  user_code: string;
  interval?: number;
  verification_uri?: string;
  verification_uri_complete?: string;
}

interface DeviceTokenResponse {
  authorization_code: string;
  code_verifier: string;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

const sessions = new Map<string, DeviceSession>();

function clientId(): string {
  return process.env.OPENAI_CLIENT_ID?.trim() || DEFAULT_CODEX_CLIENT_ID;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Codex authorization failed';
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) {
    let message = `${label} failed with HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
      if (detail) message += `: ${detail}`;
    } catch {
      // Do not expose an arbitrary upstream HTML response.
    }
    throw new Error(message);
  }
  return JSON.parse(body) as T;
}

function decodeJwtPayload(token?: string): UnknownRecord | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as UnknownRecord;
  } catch {
    return null;
  }
}

function findString(value: unknown, keys: Set<string>): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as UnknownRecord)) {
    if (keys.has(key) && typeof child === 'string' && child.trim()) return child.trim();
    const nested = findString(child, keys);
    if (nested) return nested;
  }
  return null;
}

function accountIdFromTokens(tokens: OAuthTokenResponse): string | null {
  const keys = new Set(['chatgpt_account_id', 'account_id']);
  return findString(decodeJwtPayload(tokens.id_token), keys)
    ?? findString(decodeJwtPayload(tokens.access_token), keys);
}

function emailFromTokens(tokens: OAuthTokenResponse): string | null {
  return findString(decodeJwtPayload(tokens.id_token), new Set(['email']));
}

function tokenExpiry(tokens: OAuthTokenResponse): string | undefined {
  if (Number.isFinite(tokens.expires_in) && Number(tokens.expires_in) > 0) {
    return new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString();
  }
  const exp = decodeJwtPayload(tokens.access_token)?.exp;
  return typeof exp === 'number' ? new Date(exp * 1000).toISOString() : undefined;
}

async function exchangeDeviceCode(device: DeviceTokenResponse): Promise<OAuthTokenResponse> {
  const response = await proxyFetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: device.authorization_code,
      redirect_uri: DEVICE_CALLBACK_URL,
      client_id: clientId(),
      code_verifier: device.code_verifier,
    }),
  }, 'openai-codex', 'unknown', 30_000);
  const tokens = await readJson<OAuthTokenResponse>(response, 'Codex token exchange');
  if (!tokens.access_token) throw new Error('Codex token exchange returned no access token');
  return tokens;
}

async function saveAuthorizedAccount(tokens: OAuthTokenResponse) {
  const accountId = accountIdFromTokens(tokens);
  const access = encryptCodexToken(tokens.access_token);
  const refresh = encryptCodexToken(tokens.refresh_token ?? '');
  const db = getDb();
  const accountDbId = createCodexAccount(db, {
    label: emailFromTokens(tokens) ?? 'OpenAI Codex OAuth',
    account_id: accountId ?? undefined,
    access_token_encrypted: access.encrypted,
    access_token_iv: access.iv,
    access_token_auth_tag: access.authTag,
    refresh_token_encrypted: refresh.encrypted,
    refresh_token_iv: refresh.iv,
    refresh_token_auth_tag: refresh.authTag,
    token_expires_at: tokenExpiry(tokens),
  });

  let models: string[] = [];
  let modelDiscoveryError: string | null = null;
  try {
    models = await discoverCodexModels(tokens.access_token, accountId);
    replaceCodexAccountModels(db, accountDbId, models);
  } catch (error) {
    modelDiscoveryError = safeError(error);
  }
  return { accountDbId, accountId, models, modelDiscoveryError };
}

async function pollDeviceSession(session: DeviceSession): Promise<void> {
  while (Date.now() - session.createdAt < MAX_LOGIN_AGE_MS && session.status === 'pending') {
    await new Promise(resolve => setTimeout(resolve, session.intervalMs));
    const response = await proxyFetch(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }),
    }, 'openai-codex', 'unknown', 30_000);

    if (response.status === 403 || response.status === 404) continue;
    const deviceToken = await readJson<DeviceTokenResponse>(response, 'Codex device authorization');
    const saved = await saveAuthorizedAccount(await exchangeDeviceCode(deviceToken));
    session.status = 'complete';
    session.importedAccountId = saved.accountDbId;
    session.accountId = saved.accountId;
    session.models = saved.models;
    session.modelDiscoveryError = saved.modelDiscoveryError;
    return;
  }
  if (session.status === 'pending') {
    session.status = 'failed';
    session.error = 'Codex authorization timed out. Please start again.';
  }
}

export async function startCodexDeviceAuthorization() {
  const response = await proxyFetch(DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId() }),
  }, 'openai-codex', 'unknown', 30_000);
  const result = await readJson<DeviceCodeResponse>(response, 'Codex device authorization');
  if (!result.device_auth_id || !result.user_code) {
    throw new Error('Codex device authorization returned an invalid response');
  }

  const session: DeviceSession = {
    id: crypto.randomUUID(),
    deviceAuthId: result.device_auth_id,
    userCode: result.user_code,
    intervalMs: Math.max(2_000, Number(result.interval || 5) * 1000),
    createdAt: Date.now(),
    status: 'pending',
  };
  sessions.set(session.id, session);
  void pollDeviceSession(session).catch(error => {
    session.status = 'failed';
    session.error = safeError(error);
  });
  return {
    loginId: session.id,
    verificationUrl: result.verification_uri_complete || result.verification_uri || DEVICE_VERIFICATION_URL,
    userCode: session.userCode,
    expiresInSeconds: MAX_LOGIN_AGE_MS / 1000,
  };
}

export function getCodexDeviceAuthorization(loginId: string) {
  const session = sessions.get(loginId);
  if (!session) return null;
  return {
    status: session.status,
    imported: session.status === 'complete' ? 1 : 0,
    account_id: session.accountId ?? null,
    models: session.models ?? [],
    model_discovery_error: session.modelDiscoveryError ?? null,
    error: session.error ?? null,
  };
}
