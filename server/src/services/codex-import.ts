import fs from 'fs';
import path from 'path';

import { getDb } from '../db/index.js';
import { initEncryptionKey, isEncryptionKeyInitialized } from '../lib/crypto.js';
import { encryptCodexToken } from './codex-token.js';
import { discoverCodexModels } from './codex-model-discovery.js';

type CodexAuthPayload = {
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
  };
};

export async function importCodexAuthPayload(auth: CodexAuthPayload) {
  if (!isEncryptionKeyInitialized()) initEncryptionKey(getDb());

  const tokens = auth.tokens;
  if (
    typeof tokens?.access_token !== 'string' ||
    !tokens.access_token ||
    typeof tokens?.refresh_token !== 'string' ||
    !tokens.refresh_token
  ) {
    throw new Error('Codex token missing');
  }
  const accountId = typeof tokens.account_id === 'string' && tokens.account_id
    ? tokens.account_id
    : null;

  const accessToken = encryptCodexToken(tokens.access_token);
  const refreshToken = encryptCodexToken(tokens.refresh_token);

  let modelIds: string[] = [];
  let modelDiscoveryError: string | null = null;
  try {
    modelIds = await discoverCodexModels(tokens.access_token, accountId);
  } catch (error) {
    modelDiscoveryError = error instanceof Error ? error.message : 'Codex model discovery failed';
  }

  return {
    account_id: accountId,
    access_token_encrypted: accessToken.encrypted,
    access_token_iv: accessToken.iv,
    access_token_auth_tag: accessToken.authTag,
    refresh_token_encrypted: refreshToken.encrypted,
    refresh_token_iv: refreshToken.iv,
    refresh_token_auth_tag: refreshToken.authTag,
    model_ids: modelIds,
    model_discovery_error: modelDiscoveryError,
  };
}

export async function importLocalCodexAuth() {
  // Import and provider decryption must share the process-wide key initialized
  // for the active database. This also makes direct service use fail clearly
  // instead of encrypting with an uninitialized or different key.
  if (!isEncryptionKeyInitialized()) initEncryptionKey(getDb());

  const authPath = path.join(
    process.env.USERPROFILE || '',
    '.codex',
    'auth.json',
  );

  if (!fs.existsSync(authPath)) {
    throw new Error('Codex auth.json not found');
  }

  const raw = fs.readFileSync(authPath, 'utf8');
  return importCodexAuthPayload(JSON.parse(raw) as CodexAuthPayload);
}
