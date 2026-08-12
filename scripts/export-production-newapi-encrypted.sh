#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# This script keeps the production database volume read-only. After maintenance
# mode is verified, it creates one run-bound online SQLite backup in a dedicated
# /root temporary directory. The snapshot and ciphertext are removed on exit.

readonly PRODUCTION_CONTAINER='tuoke-prod-freellmapi-1'
readonly EXPECTED_DATA_VOLUME='tuoke-prod_freellmapi-data'
readonly EXPORT_TEMP_ROOT='/root/tuoke-newapi-export-tmp'
readonly PUBLIC_KEY_B64="${1:-}"
readonly RUN_ID="${2:-}"
readonly RUN_ATTEMPT="${3:-}"
readonly RUN_REPOSITORY="${4:-}"
readonly RUN_COMMIT="${5:-}"

SNAPSHOT_DIR=''
SNAPSHOT_DB=''
CIPHERTEXT_TEMP=''
ENCRYPTION_KEY=''

cleanup() {
  local status="${1:-$?}"
  trap - EXIT HUP INT TERM
  if [[ -n "$SNAPSHOT_DIR" && "$SNAPSHOT_DIR" == "$EXPORT_TEMP_ROOT"/run-"$RUN_ID"-"$RUN_ATTEMPT".* ]]; then
    if [[ -L "$SNAPSHOT_DIR" ]]; then
      printf 'encrypted export cleanup refused a symbolic-link temporary path\n' >&2
      rm -f -- "$SNAPSHOT_DIR" 2>/dev/null || true
      status=1
    elif [[ -e "$SNAPSHOT_DIR" ]] && ! rm -rf --one-file-system -- "$SNAPSHOT_DIR"; then
      printf 'encrypted export cleanup failed for the run-specific temporary directory\n' >&2
      status=1
    fi
  fi
  rmdir -- "$EXPORT_TEMP_ROOT" 2>/dev/null || true
  unset ENCRYPTION_KEY EXPORT_RECIPIENT_PUBLIC_KEY_B64
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'cleanup 129' HUP
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

stage() { printf 'export_stage=%s\n' "$1" >&2; }
fail() { printf 'encrypted export failed: %s\n' "$1" >&2; exit 1; }

verify_live_maintenance() {
  docker exec -i "$PRODUCTION_CONTAINER" node --input-type=module - <<'NODE'
import Database from 'better-sqlite3';
try {
  const db = new Database('/app/server/data/freeapi.db', { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  const maintenance = db.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").get()?.value;
  db.close();
  if (maintenance !== '1') throw new Error('maintenance mode is not enabled');
} catch {
  console.error('production maintenance verification failed');
  process.exit(1);
}
NODE
}

stage preflight
[[ "$(id -u)" -eq 0 ]] || fail 'root is required for read-only backup access'
[[ "$PUBLIC_KEY_B64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || fail 'recipient public key is missing or malformed'
(( ${#PUBLIC_KEY_B64} >= 300 && ${#PUBLIC_KEY_B64} <= 16384 )) || fail 'recipient public key length is invalid'
[[ "$RUN_ID" =~ ^[1-9][0-9]{0,19}$ ]] || fail 'export run id is invalid'
[[ "$RUN_ATTEMPT" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'export run attempt is invalid'
[[ "$RUN_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'export repository is invalid'
[[ "$RUN_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail 'export workflow commit is invalid'

docker inspect "$PRODUCTION_CONTAINER" >/dev/null 2>&1 || fail 'production container was not found'
[[ "$(docker inspect --format '{{.State.Status}}' "$PRODUCTION_CONTAINER")" == 'running' ]] || fail 'production container is not running'
[[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/server/data"}}{{.Name}}{{end}}{{end}}' "$PRODUCTION_CONTAINER")" == "$EXPECTED_DATA_VOLUME" ]] || fail 'production data volume did not match the pinned volume'

# Maintenance is checked before and after the online backup. The source volume
# is mounted read-only, so only the run-specific host snapshot can be written.
verify_live_maintenance

PRODUCTION_IMAGE="$(docker inspect --format '{{.Image}}' "$PRODUCTION_CONTAINER")"
[[ "$PRODUCTION_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'production image id is invalid'
docker image inspect "$PRODUCTION_IMAGE" >/dev/null 2>&1 || fail 'production image is unavailable'

if [[ -e "$EXPORT_TEMP_ROOT" || -L "$EXPORT_TEMP_ROOT" ]]; then
  [[ -d "$EXPORT_TEMP_ROOT" && ! -L "$EXPORT_TEMP_ROOT" ]] || fail 'export temporary root is unsafe'
else
  install -d -m 0700 -o root -g root "$EXPORT_TEMP_ROOT"
fi
chmod 0700 "$EXPORT_TEMP_ROOT"
[[ "$(stat -c '%u:%g:%a' "$EXPORT_TEMP_ROOT")" == '0:0:700' ]] || fail 'export temporary root permissions are unsafe'

SNAPSHOT_DIR="$(mktemp -d "$EXPORT_TEMP_ROOT/run-${RUN_ID}-${RUN_ATTEMPT}.XXXXXXXX")"
SNAPSHOT_DIR="$(readlink -f -- "$SNAPSHOT_DIR")"
[[ "$SNAPSHOT_DIR" == "$EXPORT_TEMP_ROOT"/run-"$RUN_ID"-"$RUN_ATTEMPT".* ]] || fail 'snapshot directory escaped the export temporary root'
chmod 0700 "$SNAPSHOT_DIR"
SNAPSHOT_DB="$SNAPSHOT_DIR/freeapi-snapshot.db"

stage create_fresh_snapshot
docker run --rm \
  --network none \
  --read-only \
  --user 0:0 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 64 \
  --memory 768m \
  --cpus 1.5 \
  --mount "type=volume,src=$EXPECTED_DATA_VOLUME,dst=/source,readonly" \
  --mount "type=bind,src=$SNAPSHOT_DIR,dst=/snapshot" \
  --entrypoint node \
  "$PRODUCTION_IMAGE" \
  --input-type=module - <<'NODE'
import Database from 'better-sqlite3';

let source;
let snapshot;
try {
  source = new Database('/source/freeapi.db', { readonly: true, fileMustExist: true });
  source.pragma('query_only = ON');
  const maintenance = source.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").get()?.value;
  if (maintenance !== '1') throw new Error('maintenance mode is not enabled');
  await source.backup('/snapshot/freeapi-snapshot.db');
  source.close();
  source = undefined;

  // A backup of a WAL source may retain WAL in the database header even though
  // the backup itself is complete. Normalize only the temporary snapshot so it
  // is a self-contained file that can be mounted read-only by the encryptor.
  snapshot = new Database('/snapshot/freeapi-snapshot.db', { fileMustExist: true });
  const journalMode = String(snapshot.pragma('journal_mode = DELETE', { simple: true }) ?? '').toLowerCase();
  if (journalMode !== 'delete') throw new Error('snapshot journal mode normalization failed');
  if (snapshot.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('snapshot quick_check failed');
  const snapshotMaintenance = snapshot.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").get()?.value;
  if (snapshotMaintenance !== '1') throw new Error('snapshot maintenance marker is missing');
} catch {
  console.error('fresh SQLite snapshot creation failed');
  process.exitCode = 1;
} finally {
  snapshot?.close();
  source?.close();
}
NODE

[[ -s "$SNAPSHOT_DB" ]] || fail 'fresh SQLite snapshot was not created'
[[ ! -e "$SNAPSHOT_DB-wal" && ! -e "$SNAPSHOT_DB-shm" && ! -e "$SNAPSHOT_DB-journal" ]] || fail 'fresh SQLite snapshot left a sidecar file'
chmod 0600 "$SNAPSHOT_DB"
verify_live_maintenance
readonly SNAPSHOT_CREATED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

# Keep the production AES key only in process memory. Prefer the container's
# runtime environment so Compose env indirections stay transparent, then use a
# read-only inspect as a compatibility fallback. Neither path prints the value.
ENCRYPTION_KEY="$(docker exec "$PRODUCTION_CONTAINER" printenv ENCRYPTION_KEY 2>/dev/null || true)"
if [[ -z "$ENCRYPTION_KEY" ]]; then
  ENCRYPTION_KEY="$(
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$PRODUCTION_CONTAINER" \
      | sed -n 's/^ENCRYPTION_KEY=//p' \
      | tail -n 1
  )"
fi
[[ "$ENCRYPTION_KEY" =~ ^[0-9A-Fa-f]{64}$ ]] || fail 'production encryption key is unavailable'

CIPHERTEXT_TEMP="$SNAPSHOT_DIR/export.enc.json"
: >"$CIPHERTEXT_TEMP"
chmod 0600 "$CIPHERTEXT_TEMP"

stage encrypt_export
EXPORT_RECIPIENT_PUBLIC_KEY_B64="$PUBLIC_KEY_B64" \
ENCRYPTION_KEY="$ENCRYPTION_KEY" \
EXPORT_RUN_ID="$RUN_ID" \
EXPORT_RUN_ATTEMPT="$RUN_ATTEMPT" \
EXPORT_RUN_REPOSITORY="$RUN_REPOSITORY" \
EXPORT_RUN_COMMIT="$RUN_COMMIT" \
EXPORT_SNAPSHOT_CREATED_AT="$SNAPSHOT_CREATED_AT" \
docker run --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 64 \
  --memory 768m \
  --cpus 1.5 \
  --mount "type=bind,src=$SNAPSHOT_DB,dst=/input/freeapi.db,readonly" \
  --env ENCRYPTION_KEY \
  --env EXPORT_RECIPIENT_PUBLIC_KEY_B64 \
  --env EXPORT_RUN_ID \
  --env EXPORT_RUN_ATTEMPT \
  --env EXPORT_RUN_REPOSITORY \
  --env EXPORT_RUN_COMMIT \
  --env EXPORT_SNAPSHOT_CREATED_AT \
  --entrypoint node \
  "$PRODUCTION_IMAGE" \
  --input-type=module - >"$CIPHERTEXT_TEMP" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const EXPORT_FORMAT = 'tuoke-newapi-migration-export/v1';
const ENVELOPE_FORMAT = 'tuoke-newapi-export-envelope/v2';
const OAEP_LABEL = Buffer.from('tuoke-newapi-export-key/v1', 'utf8');
const DB_PATH = '/input/freeapi.db';

function abort() {
  console.error('encrypted export generation failed');
  process.exit(1);
}

function requireHex(name, value, bytes) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`invalid encrypted field: ${name}`);
  }
  return Buffer.from(value, 'hex');
}

function hashFileSync(path) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function assertColumns(db, table, required) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) throw new Error(`required table is missing: ${table}`);
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  for (const column of required) {
    if (!columns.has(column)) throw new Error(`required column is missing: ${table}.${column}`);
  }
}

function main() {
  const encryptionKey = requireHex('ENCRYPTION_KEY', process.env.ENCRYPTION_KEY?.trim(), 32);
  const runId = process.env.EXPORT_RUN_ID ?? '';
  const runAttemptText = process.env.EXPORT_RUN_ATTEMPT ?? '';
  const runRepository = process.env.EXPORT_RUN_REPOSITORY ?? '';
  const runCommit = process.env.EXPORT_RUN_COMMIT ?? '';
  const snapshotCreatedAt = process.env.EXPORT_SNAPSHOT_CREATED_AT ?? '';
  if (!/^[1-9][0-9]{0,19}$/.test(runId)) throw new Error('invalid export run id');
  if (!/^[1-9][0-9]{0,9}$/.test(runAttemptText)) throw new Error('invalid export run attempt');
  const runAttempt = Number(runAttemptText);
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) throw new Error('export run attempt is unsafe');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(runRepository)) throw new Error('invalid export repository');
  if (!/^[0-9a-f]{40}$/.test(runCommit)) throw new Error('invalid export workflow commit');
  if (!Number.isFinite(Date.parse(snapshotCreatedAt))) throw new Error('invalid snapshot timestamp');
  const publicPem = Buffer.from(process.env.EXPORT_RECIPIENT_PUBLIC_KEY_B64 ?? '', 'base64').toString('utf8');
  if (!publicPem.includes('-----BEGIN PUBLIC KEY-----') || publicPem.includes('PRIVATE KEY')) {
    throw new Error('recipient key is not a public PEM');
  }
  const publicKey = crypto.createPublicKey(publicPem);
  if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error('recipient key must be RSA with at least 2048 bits');
  }

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  const journalMode = String(db.pragma('journal_mode', { simple: true }) ?? '').toLowerCase();
  if (journalMode !== 'delete') throw new Error('snapshot is not a self-contained rollback-journal database');
  if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('snapshot quick_check failed');
  if (db.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").get()?.value !== '1') {
    throw new Error('snapshot was not taken in maintenance mode');
  }

  const schema = {
    users: ['id', 'email', 'password_hash', 'created_at', 'role', 'status', 'balance_micro', 'reserved_balance_micro', 'deleted_at'],
    api_keys: ['id', 'platform', 'label', 'encrypted_key', 'iv', 'auth_tag', 'status', 'enabled', 'created_at', 'last_checked_at', 'base_url', 'role'],
    models: ['id', 'platform', 'model_id', 'upstream_model_id', 'display_name', 'intelligence_rank', 'speed_rank', 'size_label', 'rpm_limit', 'rpd_limit', 'tpm_limit', 'tpd_limit', 'monthly_token_budget', 'context_window', 'enabled', 'supports_vision', 'supports_tools', 'key_id', 'paid_input_per_m', 'paid_output_per_m'],
    codex_groups: ['id', 'name', 'description', 'enabled', 'multiplier_milli', 'max_concurrency', 'created_at', 'updated_at'],
    codex_group_models: ['group_id', 'model_id', 'created_at', 'input_price_micro_per_million_override', 'output_price_micro_per_million_override', 'multiplier_milli_override', 'cached_input_multiplier_milli_override'],
    codex_relay_sources: ['id', 'api_key_id', 'name', 'codex_group_id', 'protocol', 'enabled', 'priority', 'status', 'base_url', 'created_at', 'updated_at'],
    codex_relay_source_keys: ['api_key_id', 'source_id', 'label', 'priority', 'enabled', 'status', 'created_at', 'updated_at'],
    codex_relay_source_models: ['source_id', 'public_model_id', 'upstream_model_id', 'enabled', 'supports_tools', 'supports_vision', 'created_at', 'updated_at'],
  };
  for (const [table, columns] of Object.entries(schema)) assertColumns(db, table, columns);

  const decryptSecret = (row) => {
    const iv = requireHex('iv', row.iv, 16);
    const tag = requireHex('auth_tag', row.auth_tag, 16);
    if (typeof row.encrypted_key !== 'string' || row.encrypted_key.length === 0 || row.encrypted_key.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(row.encrypted_key)) {
      throw new Error('invalid encrypted key material');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const secret = decipher.update(row.encrypted_key, 'hex', 'utf8') + decipher.final('utf8');
    if (!secret.trim()) throw new Error('decrypted key is empty');
    return secret;
  };

  const users = db.prepare(`
    SELECT id AS source_user_id, email, password_hash, role, status,
           balance_micro, reserved_balance_micro, deleted_at, created_at
    FROM users
    ORDER BY id
  `).all();

  const providerKeyRows = db.prepare(`
    SELECT id AS source_api_key_id, platform, label, encrypted_key, iv, auth_tag,
           status, enabled, base_url, created_at, last_checked_at
    FROM api_keys
    WHERE role = 'provider'
    ORDER BY id
  `).all();
  const providerKeys = providerKeyRows.map((row) => ({
    source_api_key_id: row.source_api_key_id,
    platform: row.platform,
    label: row.label,
    api_key: decryptSecret(row),
    status: row.status,
    enabled: row.enabled,
    base_url: row.base_url,
    created_at: row.created_at,
    last_checked_at: row.last_checked_at,
  }));

  const providerModels = db.prepare(`
    SELECT m.id AS source_model_id, m.platform, m.model_id, m.upstream_model_id,
           m.display_name, m.intelligence_rank, m.speed_rank, m.size_label,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
           m.monthly_token_budget, m.context_window, m.enabled,
           m.supports_vision, m.supports_tools, m.key_id AS source_api_key_id,
           m.paid_input_per_m, m.paid_output_per_m
    FROM models m
    WHERE EXISTS (
      SELECT 1
      FROM api_keys k
      WHERE k.role = 'provider'
        AND ((m.key_id IS NOT NULL AND k.id = m.key_id)
          OR (m.key_id IS NULL AND k.platform = m.platform))
    )
    ORDER BY m.platform, m.model_id, m.id
  `).all();

  const relayKeyRows = db.prepare(`
    SELECT k.id AS source_api_key_id, sk.source_id, k.platform,
           COALESCE(NULLIF(sk.label, ''), k.label) AS label,
           k.encrypted_key, k.iv, k.auth_tag,
           sk.priority, sk.enabled, sk.status,
           sk.created_at, sk.updated_at
    FROM api_keys k
    JOIN codex_relay_source_keys sk ON sk.api_key_id = k.id
    WHERE k.role = 'codex_relay'
    ORDER BY sk.source_id, sk.priority, k.id
  `).all();
  const relayKeys = relayKeyRows.map((row) => ({
    source_api_key_id: row.source_api_key_id,
    source_id: row.source_id,
    platform: row.platform,
    label: row.label,
    api_key: decryptSecret(row),
    priority: row.priority,
    enabled: row.enabled,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  const relaySources = db.prepare(`
    SELECT id AS source_id, api_key_id AS primary_source_api_key_id, name,
           codex_group_id AS source_group_id, protocol, enabled, priority,
           status, base_url, created_at, updated_at
    FROM codex_relay_sources
    ORDER BY id
  `).all();
  const relayModels = db.prepare(`
    SELECT source_id, public_model_id, upstream_model_id, enabled,
           supports_tools, supports_vision, created_at, updated_at
    FROM codex_relay_source_models
    ORDER BY source_id, public_model_id
  `).all();
  const groups = db.prepare(`
    SELECT id AS source_group_id, name, description, enabled, multiplier_milli,
           max_concurrency, created_at, updated_at
    FROM codex_groups
    ORDER BY id
  `).all();
  const groupModels = db.prepare(`
    SELECT group_id AS source_group_id, model_id, created_at,
           input_price_micro_per_million_override,
           output_price_micro_per_million_override,
           multiplier_milli_override,
           cached_input_multiplier_milli_override
    FROM codex_group_models
    ORDER BY group_id, model_id
  `).all();

  const allRelayVaultCount = Number(db.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE role = 'codex_relay'").get().count);
  const sourceIds = new Set(relaySources.map((row) => row.source_id));
  const relayKeyIds = new Set(relayKeys.map((row) => row.source_api_key_id));
  const groupIds = new Set(groups.map((row) => row.source_group_id));
  if (allRelayVaultCount !== relayKeys.length) throw new Error('an unlinked relay credential exists');
  for (const source of relaySources) {
    if (!relayKeyIds.has(source.primary_source_api_key_id)) throw new Error('relay primary key is missing');
    if (source.source_group_id != null && !groupIds.has(source.source_group_id)) throw new Error('relay group is missing');
    if (!relayKeys.some((key) => key.source_id === source.source_id)) throw new Error('relay source has no key');
  }
  for (const key of relayKeys) if (!sourceIds.has(key.source_id)) throw new Error('relay key source is missing');
  for (const model of relayModels) if (!sourceIds.has(model.source_id)) throw new Error('relay model source is missing');
  for (const model of groupModels) if (!groupIds.has(model.source_group_id)) throw new Error('group model group is missing');

  db.close();

  const exportedAt = new Date().toISOString();
  if (Date.parse(exportedAt) < Date.parse(snapshotCreatedAt)) throw new Error('export timestamp predates snapshot');
  const sourceDatabaseSha256 = hashFileSync(DB_PATH);
  const exportObject = {
    format: EXPORT_FORMAT,
    exported_at: exportedAt,
    source: {
      snapshot_kind: 'fresh_maintenance_snapshot',
      snapshot_created_at: snapshotCreatedAt,
      database_sha256: sourceDatabaseSha256,
      export_run: {
        provider: 'github_actions',
        repository: runRepository,
        run_id: runId,
        run_attempt: runAttempt,
        workflow_commit: runCommit,
      },
    },
    users,
    provider: {
      api_keys: providerKeys,
      models: providerModels,
    },
    codex_relay: {
      groups,
      group_models: groupModels,
      sources: relaySources,
      api_keys: relayKeys,
      models: relayModels,
    },
  };

  const plaintext = Buffer.from(JSON.stringify(exportObject), 'utf8');
  const plaintextSha256 = crypto.createHash('sha256').update(plaintext).digest('hex');
  const publicKeySha256 = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const counts = {
    users: users.length,
    provider_api_keys: providerKeys.length,
    provider_models: providerModels.length,
    codex_relay_groups: groups.length,
    codex_relay_group_models: groupModels.length,
    codex_relay_sources: relaySources.length,
    codex_relay_api_keys: relayKeys.length,
    codex_relay_models: relayModels.length,
  };
  const protectedMetadata = {
    schema_version: 2,
    envelope_format: ENVELOPE_FORMAT,
    export_format: EXPORT_FORMAT,
    created_at: exportedAt,
    snapshot_created_at: snapshotCreatedAt,
    export_run: {
      provider: 'github_actions',
      repository: runRepository,
      run_id: runId,
      run_attempt: runAttempt,
      workflow_commit: runCommit,
    },
    recipient_public_key_sha256: publicKeySha256,
    source_database_sha256: sourceDatabaseSha256,
    export_plaintext_sha256: plaintextSha256,
    counts,
    crypto: {
      payload_algorithm: 'AES-256-GCM',
      key_wrap_algorithm: 'RSA-OAEP-SHA256',
      key_wrap_label_b64: OAEP_LABEL.toString('base64'),
    },
  };
  const protectedBytes = Buffer.from(JSON.stringify(protectedMetadata), 'utf8');
  const payloadKey = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', payloadKey, nonce, { authTagLength: 16 });
  cipher.setAAD(protectedBytes);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wrappedKey = crypto.publicEncrypt({
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
    oaepLabel: OAEP_LABEL,
  }, payloadKey);
  const envelope = {
    format: ENVELOPE_FORMAT,
    protected_b64: protectedBytes.toString('base64'),
    wrapped_key_b64: wrappedKey.toString('base64'),
    payload: {
      nonce_b64: nonce.toString('base64'),
      auth_tag_b64: authTag.toString('base64'),
      ciphertext_b64: ciphertext.toString('base64'),
    },
  };

  process.stdout.write(JSON.stringify(envelope));
  plaintext.fill(0);
  protectedBytes.fill(0);
  payloadKey.fill(0);
  encryptionKey.fill(0);
}

try {
  main();
} catch {
  abort();
}
NODE

unset ENCRYPTION_KEY EXPORT_RECIPIENT_PUBLIC_KEY_B64
[[ -s "$CIPHERTEXT_TEMP" ]] || fail 'encrypted package was not generated'

stage emit_ciphertext
cat -- "$CIPHERTEXT_TEMP"
printf '\n'
