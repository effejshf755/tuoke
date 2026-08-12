import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MARKER = 'TUOKE_USER_USAGE_PRIVACY_R1';
const server = process.argv[2] ?? '/app/server/dist';
const client = process.argv[3] ?? '/app/client/dist';

const pendingWrites = new Map();

function sourceFor(path) {
  return pendingWrites.get(path) ?? readFileSync(path, 'utf8');
}

function countOf(source, needle) {
  return source.split(needle).length - 1;
}

function replaceRequired(path, oldText, newText, expected = 1) {
  const source = sourceFor(path);
  const count = countOf(source, oldText);
  if (count !== expected) {
    throw new Error(`${path}: expected ${expected} occurrences, found ${count}: ${oldText.slice(0, 80)}`);
  }
  pendingWrites.set(path, source.split(oldText).join(newText));
}

function replaceOptional(path, oldText, newText, allowed = [0, 1]) {
  const source = sourceFor(path);
  const count = countOf(source, oldText);
  if (!allowed.includes(count)) {
    throw new Error(`${path}: unexpected occurrence count ${count}: ${oldText.slice(0, 80)}`);
  }
  if (count > 0) pendingWrites.set(path, source.split(oldText).join(newText));
  return count;
}

function replaceNormalizedOptional(path, oldText, newText, allowed = [0, 1]) {
  const source = sourceFor(path);
  const normalized = source.replace(/\r\n/g, '\n');
  const count = countOf(normalized, oldText);
  if (!allowed.includes(count)) {
    throw new Error(`${path}: unexpected normalized occurrence count ${count}: ${oldText.slice(0, 80)}`);
  }
  if (count > 0) pendingWrites.set(path, normalized.split(oldText).join(newText));
  return count;
}

function assertIncludes(path, needle, description = needle) {
  if (!sourceFor(path).includes(needle)) {
    throw new Error(`${path}: missing ${description}`);
  }
}

function assertExcludes(path, needle, description = needle) {
  if (sourceFor(path).includes(needle)) {
    throw new Error(`${path}: forbidden ${description}`);
  }
}

// ---------------------------------------------------------------------------
// Ordinary-user APIs: use the immutable per-request compute-point snapshots.
// Missing historical snapshots fail closed to zero and never fall back to raw
// upstream token counts.
// ---------------------------------------------------------------------------

{
  const path = join(server, 'routes/user.js');
  assertIncludes(path, 'input_compute_points', 'request compute-point columns');
  assertIncludes(path, 'output_compute_points', 'request compute-point columns');
  assertIncludes(path, 'const inputUsage = `CASE', 'snapshot-aware request history shape');
  assertIncludes(path, 'USER_VISIBLE_REQUEST_RESULT_SQL', 'final-result user visibility filter');

  replaceOptional(path, 'ELSE COALESCE(r.input_tokens, 0)', `ELSE 0 /* ${MARKER} */`);
  replaceOptional(path, 'ELSE COALESCE(r.output_tokens, 0)', `ELSE 0 /* ${MARKER} */`);
  replaceOptional(path, 'ELSE 1000000', `ELSE 0 /* ${MARKER} */`);

  // Older images still aggregate the user summary directly from raw fields.
  replaceOptional(path, 'COALESCE(SUM(input_tokens), 0)', 'COALESCE(SUM(input_compute_points), 0)');
  replaceOptional(path, 'COALESCE(SUM(output_tokens), 0)', 'COALESCE(SUM(output_compute_points), 0)');
  replaceOptional(
    path,
    'SUM(input_tokens + output_tokens)',
    'SUM(input_compute_points + output_compute_points)',
  );

  // Playground history has no compute-point snapshot columns. Do not expose
  // the raw values from that auxiliary table.
  replaceOptional(path, 'prompt_tokens AS promptTokens,', `0 AS promptTokens, /* ${MARKER} */`);
  replaceOptional(path, 'completion_tokens AS completionTokens,', '0 AS completionTokens,');
  replaceOptional(path, 'total_tokens AS totalTokens,', '0 AS totalTokens,');

  assertExcludes(path, 'ELSE COALESCE(r.input_tokens, 0)', 'raw input fallback');
  assertExcludes(path, 'ELSE COALESCE(r.output_tokens, 0)', 'raw output fallback');
}

{
  const path = join(server, 'routes/user-analytics.js');
  assertIncludes(path, 'input_compute_points', 'analytics compute-point input');
  assertIncludes(path, 'output_compute_points', 'analytics compute-point output');
  assertIncludes(path, 'const inputUsage = `CASE', 'snapshot-aware analytics shape');
  assertIncludes(path, 'USER_VISIBLE_REQUEST_RESULT_SQL', 'final-result analytics visibility filter');
  replaceOptional(path, 'ELSE COALESCE(r.input_tokens, 0)', `ELSE 0 /* ${MARKER} */`);
  replaceOptional(path, 'ELSE COALESCE(r.output_tokens, 0)', `ELSE 0 /* ${MARKER} */`);
  replaceOptional(path, 'ELSE 1000000', `ELSE 0 /* ${MARKER} */`);
  assertExcludes(path, 'ELSE COALESCE(r.input_tokens, 0)', 'raw analytics input fallback');
  assertExcludes(path, 'ELSE COALESCE(r.output_tokens, 0)', 'raw analytics output fallback');
}

{
  const path = join(server, 'routes/user-wallet.js');
  // Current wallet route joins the request snapshot. An image that predates
  // that join is rejected instead of being patched ambiguously.
  assertIncludes(path, 'LEFT JOIN requests r', 'wallet request snapshot join');
  assertIncludes(path, 'r.input_compute_points', 'wallet input snapshot');
  assertIncludes(path, 'r.output_compute_points', 'wallet output snapshot');
  replaceOptional(path, 'ELSE COALESCE(wt.input_tokens, 0)', `ELSE 0 /* ${MARKER} */`);
  replaceOptional(path, 'ELSE COALESCE(wt.cached_input_tokens, 0)', `ELSE 0 /* ${MARKER} */`);
  replaceOptional(path, 'ELSE COALESCE(wt.cache_write_tokens, 0)', `ELSE 0 /* ${MARKER} */`);
  replaceOptional(path, 'ELSE COALESCE(wt.output_tokens, 0)', `ELSE 0 /* ${MARKER} */`);
  assertExcludes(path, 'ELSE COALESCE(wt.input_tokens, 0)', 'raw wallet input fallback');
  assertExcludes(path, 'ELSE COALESCE(wt.output_tokens, 0)', 'raw wallet output fallback');
}

{
  const path = join(server, 'services/consumer-api-keys.js');
  assertIncludes(path, 'r.input_compute_points', 'API Key input snapshot');
  assertIncludes(path, 'r.output_compute_points', 'API Key output snapshot');

  // Some deployed versions already fixed per-key totals but still calculate
  // the optional monthly usage helper from raw tokens.
  const rawMonthly = `THEN
                COALESCE(
                  r.input_tokens,
                  0
                )
                +
                COALESCE(
                  r.output_tokens,
                  0
                )`;
  const pointMonthly = `THEN
                CASE
                  WHEN COALESCE(r.compute_points_per_million_tokens, 0) > 0
                  THEN
                    COALESCE(r.input_compute_points, 0)
                    +
                    COALESCE(r.output_compute_points, 0)
                  ELSE 0
                END /* ${MARKER} */`;
  replaceNormalizedOptional(path, rawMonthly, pointMonthly);
  assertExcludes(path, rawMonthly, 'raw monthly API Key usage');
  assertExcludes(path, 'r.input_tokens', 'raw monthly API Key input usage');
  assertExcludes(path, 'r.output_tokens', 'raw monthly API Key output usage');
}

{
  const path = join(server, 'services/resource-user.js');
  assertIncludes(path, 'req.input_compute_points', 'resource input snapshot');
  assertIncludes(path, 'req.output_compute_points', 'resource output snapshot');
  replaceOptional(
    path,
    'COALESCE(req.compute_points_per_million_tokens, 5000000)',
    `CASE WHEN COALESCE(req.compute_points_per_million_tokens, 0) > 0 THEN req.compute_points_per_million_tokens ELSE 0 END /* ${MARKER} */`,
    [0, 1, 2, 3],
  );
  assertExcludes(path, 'COALESCE(req.compute_points_per_million_tokens, 5000000)', 'invented historical multiplier');
}

{
  const path = join(server, 'routes/fallback.js');
  assertIncludes(path, "import { requireAdmin } from '../middleware/requireAdmin.js';", 'admin middleware import');
  replaceOptional(
    path,
    "fallbackRouter.get('/token-usage', (_req, res) => {",
    `fallbackRouter.get('/token-usage', requireAdmin, (_req, res) => { /* ${MARKER} */`,
  );
  assertIncludes(path, "fallbackRouter.get('/token-usage', requireAdmin,", 'admin-only global raw usage endpoint');
}

// ---------------------------------------------------------------------------
// Frontend: preserve the exact audited production bundle and patch only the
// ordinary-user surfaces. Admin labels and real-token pages are untouched.
// ---------------------------------------------------------------------------

const indexPath = join(client, 'index.html');
const indexHtml = readFileSync(indexPath, 'utf8');
const scriptMatch = indexHtml.match(/<script[^>]+src="(\/assets\/[^"]+\.js)"/);
if (!scriptMatch) throw new Error('client index: main JavaScript asset not found');
const oldAssetPath = join(client, scriptMatch[1].replace(/^\//, ''));
if (!existsSync(oldAssetPath)) throw new Error(`client asset missing: ${oldAssetPath}`);

// User center summary.
replaceRequired(oldAssetPath, 'label:`Token 使用量`,value:C5(g.data?.total_tokens??0)', 'label:`总计`,value:C5(g.data?.total_tokens??0)');

// The current user-center and request-history layouts already use the neutral
// labels “输入 / 缓存 / 输出 / 合计”. Keep those exact components unchanged.

// Playground API responses have already been converted to points by the quota
// middleware. Remove the extra client-side conversion so they are not multiplied
// a second time. Historical rows are zeroed server-side above.
replaceRequired(
  oldAssetPath,
  'NF($E(e.meta.prompt_tokens)),` · 输出`,` `,NF($E(e.meta.completion_tokens))',
  'NF(e.meta.prompt_tokens),` · 输出`,` `,NF(e.meta.completion_tokens)',
);

// Ordinary users may visit the model list, but the site-wide raw budget widget
// must only be queried and rendered for administrators.
replaceRequired(
  oldAssetPath,
  '{data:_}=G({queryKey:[`fallback`,`token-usage`],queryFn:()=>X(`/api/fallback/token-usage`),refetchInterval:6e4})',
  `{data:_}=G({queryKey:[\`fallback\`,\`token-usage\`],queryFn:()=>X(\`/api/fallback/token-usage\`),refetchInterval:6e4,enabled:i}) /* ${MARKER} */`,
);

// Rename the entry asset to make browser/CDN cache invalidation deterministic.
const newAssetName = 'index-user-usage-privacy-r1.js';
const newAssetPath = join(dirname(oldAssetPath), newAssetName);
if (existsSync(newAssetPath)) throw new Error(`new client asset already exists: ${newAssetPath}`);

for (const [path, source] of pendingWrites) {
  writeFileSync(path, source, 'utf8');
  if (readFileSync(path, 'utf8') !== source) throw new Error(`${path}: write verification failed`);
  console.log(`patched=${path}`);
}

renameSync(oldAssetPath, newAssetPath);
const newIndexHtml = indexHtml.replace(scriptMatch[1], `/assets/${newAssetName}`);
if (newIndexHtml === indexHtml) throw new Error('client index asset reference was not changed');
writeFileSync(indexPath, newIndexHtml, 'utf8');

const finalClient = readFileSync(newAssetPath, 'utf8');
if (!finalClient.includes(`enabled:i}) /* ${MARKER} */`)) {
  throw new Error('frontend admin-only token budget gate missing');
}
if (finalClient.includes('NF($E(e.meta.prompt_tokens))')) {
  throw new Error('playground double conversion remains');
}

console.log(`client_old_asset=${basename(oldAssetPath)}`);
console.log(`client_new_asset=${newAssetName}`);
console.log(`runtime_patch_marker=${MARKER}`);
