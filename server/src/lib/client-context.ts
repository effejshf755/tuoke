import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
  consumerUserId: number | null;
  consumerApiKeyId: number | null;
  consumerApiKeyType: 'universal' | 'codex_pool' | null;
  walletReservationId: number | null;
  codexUsageRecordId: number | null;
}

// Request-scoped caller identity, readable from anywhere below the middleware
// without threading parameters through every logRequest() call site (the chat
// proxy, responses, anthropic, fusion, embeddings and media paths all log).
const storage = new AsyncLocalStorage<ClientContext>();

function createContext(ip: string | null, userAgent: string | null): ClientContext {
  const context = { ip, userAgent } as ClientContext;
  Object.defineProperties(context, {
    consumerUserId: { value: null, writable: true, enumerable: false },
    consumerApiKeyId: { value: null, writable: true, enumerable: false },
    consumerApiKeyType: { value: null, writable: true, enumerable: false },
    walletReservationId: { value: null, writable: true, enumerable: false },
    codexUsageRecordId: { value: null, writable: true, enumerable: false },
  });
  return context;
}

// First X-Forwarded-For hop when present (reverse-proxy deployments, e.g.
// Traefik), otherwise the socket peer address. The server is LAN-only, so a
// spoofable header is an acceptable trade for working behind a proxy.
function resolveClientIp(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  const raw = first || req.socket.remoteAddress || null;
  // Normalize IPv4-mapped IPv6 ("::ffff:192.168.0.5" -> "192.168.0.5").
  return raw?.replace(/^::ffff:/i, '') ?? null;
}

// Privacy opt-out: REQUEST_ANALYTICS_LOG_CLIENT=false stores nulls instead of
// the caller's IP/UA. Read per request (not at module load) so tests and
// embedders can toggle it without re-importing.
function clientLoggingEnabled(): boolean {
  return process.env.REQUEST_ANALYTICS_LOG_CLIENT !== 'false';
}

export function clientContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!clientLoggingEnabled()) {
    storage.run(createContext(null, null), next);
    return;
  }
  const ua = req.headers['user-agent'];
  storage.run(createContext(resolveClientIp(req), typeof ua === 'string' ? ua.slice(0, 256) : null), next);
}

export function getClientContext(): ClientContext {
  return storage.getStore() ?? createContext(null, null);
}

export function setConsumerIdentity(
  userId: number,
  keyId: number,
  keyType: 'universal' | 'codex_pool' = 'universal',
): void {
  const context = storage.getStore();
  if (context) {
    context.consumerUserId = userId;
    context.consumerApiKeyId = keyId;
    context.consumerApiKeyType = keyType;
  }
}


export function setWalletReservationId(
  reservationId: number | null,
): void {
  const context = storage.getStore();

  if (context) {
    context.walletReservationId =
      reservationId;
  }
}

/** Attach the provider-side Codex usage row to the next request log entry. */
export function setCodexUsageRecordId(recordId: number | null): void {
  const context = storage.getStore();
  if (context) context.codexUsageRecordId = recordId;
}

/**
 * Consume the current Codex usage row exactly once. A request can fail over
 * between several Codex accounts; each attempt records and links its own row.
 */
export function takeCodexUsageRecordId(): number | null {
  const context = storage.getStore();
  if (!context) return null;
  const recordId = context.codexUsageRecordId;
  context.codexUsageRecordId = null;
  return recordId;
}
