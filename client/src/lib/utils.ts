import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// SQLite stores timestamps as `YYYY-MM-DD HH:MM:SS` with no timezone marker, so
// passing them straight to `new Date(...)` makes the browser read them as LOCAL
// time when they are actually UTC — shifting every displayed time by the
// viewer's offset. These helpers tag the value as UTC before parsing. (#170)

/** Convert a SQLite UTC datetime string into an ISO-8601 UTC string. */
export function sqliteUtcToIso(value: string): string {
  const trimmed = value.trim();
  // Keep explicit UTC/offset timestamps unchanged. Database timestamps without
  // a zone are UTC, whether they use a space or `T` separator.
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(trimmed)) return trimmed;
  return trimmed.replace(' ', 'T') + 'Z';
}

export const BEIJING_TIME_ZONE = 'Asia/Shanghai';

/** Format any database/ISO timestamp consistently in China Standard Time. */
export function formatBeijingDateTime(
  value: string | number | null | undefined,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  },
): string {
  if (!value) return '—';
  const date = new Date(typeof value === 'number' ? value : sqliteUtcToIso(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    ...options,
    timeZone: BEIJING_TIME_ZONE,
  }).format(date);
}

/** Format a SQLite UTC datetime string as the viewer's local time-of-day. */
export function formatSqliteUtcToLocalTime(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' },
): string {
  if (!value) return '—';
  const date = new Date(sqliteUtcToIso(value));
  if (isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    ...options,
    timeZone: BEIJING_TIME_ZONE,
  }).format(date);
}
