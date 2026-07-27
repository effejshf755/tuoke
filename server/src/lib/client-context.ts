import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
  consumerUserId: number | null;
  consumerApiKeyId: number | null;
  consumerApiKeyType: 'universal' | 'codex_pool' | 'resource_subpool' | null;
  walletReservationId: number | null;
  codexUsageRecordId: number | null;
  resourceSubpoolId: number | null;
  resourceMemberId: number | null;
  resourceQuotaReservationId: number | null;
  resourceRequestCorrelationId: string | null;
  resourceDispatchId: number | null;
  resourceUsageObserved: boolean;
  freeModelUsageDate: string | null;
  freeModelUsageCommitted: boolean;
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
    resourceSubpoolId: { value: null, writable: true, enumerable: false },
    resourceMemberId: { value: null, writable: true, enumerable: false },
    resourceQuotaReservationId: { value: null, writable: true, enumerable: false },
    resourceRequestCorrelationId: { value: null, writable: true, enumerable: false },
    resourceDispatchId: { value: null, writable: true, enumerable: false },
    resourceUsageObserved: { value: false, writable: true, enumerable: false },
    freeModelUsageDate: { value: null, writable: true, enumerable: false },
    freeModelUsageCommitted: { value: false, writable: true, enumerable: false },
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
  keyType: 'universal' | 'codex_pool' | 'resource_subpool' = 'universal',
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

export function setResourceReservation(input: {
  subpoolId: number;
  memberId: number;
  reservationId: number;
  requestCorrelationId: string;
}): void {
  const context = storage.getStore();
  if (!context) return;
  context.resourceSubpoolId = input.subpoolId;
  context.resourceMemberId = input.memberId;
  context.resourceQuotaReservationId = input.reservationId;
  context.resourceRequestCorrelationId = input.requestCorrelationId;
}

export function setResourceDispatchId(dispatchId: number | null): void {
  const context = storage.getStore();
  if (context) context.resourceDispatchId = dispatchId;
}

export function markResourceUsageObserved(): void {
  const context = storage.getStore();
  if (context && context.resourceQuotaReservationId !== null) context.resourceUsageObserved = true;
}

export function setFreeModelUsage(usageDate: string): void {
  const context = storage.getStore();
  if (context) context.freeModelUsageDate = usageDate;
}

export function markFreeModelUsageCommitted(): void {
  const context = storage.getStore();
  if (context) context.freeModelUsageCommitted = true;
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
