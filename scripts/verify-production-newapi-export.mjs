import crypto from 'node:crypto';
import fs from 'node:fs';

const [inputPath, privateKeyPath] = process.argv.slice(2);
const ENVELOPE_FORMAT = 'tuoke-newapi-export-envelope/v2';
const EXPORT_FORMAT = 'tuoke-newapi-migration-export/v1';
const OAEP_LABEL = Buffer.from('tuoke-newapi-export-key/v1', 'utf8');
const COUNT_FIELDS = [
  'users',
  'provider_api_keys',
  'provider_models',
  'codex_relay_groups',
  'codex_relay_group_models',
  'codex_relay_sources',
  'codex_relay_api_keys',
  'codex_relay_models',
];

function fail(message) {
  console.error(`encrypted export verification failed: ${message}`);
  process.exit(1);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isSha256 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const exactKeys = (name, value, expected) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is invalid`);
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) throw new Error(`${name} fields are invalid`);
};
const decodeBase64 = (name, value, minimumBytes = 1) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${name} is not base64`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < minimumBytes || decoded.toString('base64') !== value) throw new Error(`${name} is not canonical base64`);
  return decoded;
};

function requireTimestamp(name, value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} is invalid`);
}

function validateCounts(counts) {
  exactKeys('counts', counts, COUNT_FIELDS);
  for (const name of COUNT_FIELDS) {
    if (!Number.isSafeInteger(counts[name]) || counts[name] < 0) throw new Error(`count is invalid: ${name}`);
  }
}

function actualCounts(payload) {
  return {
    users: payload.users.length,
    provider_api_keys: payload.provider.api_keys.length,
    provider_models: payload.provider.models.length,
    codex_relay_groups: payload.codex_relay.groups.length,
    codex_relay_group_models: payload.codex_relay.group_models.length,
    codex_relay_sources: payload.codex_relay.sources.length,
    codex_relay_api_keys: payload.codex_relay.api_keys.length,
    codex_relay_models: payload.codex_relay.models.length,
  };
}

if (!inputPath || !privateKeyPath) fail('encrypted package and private key paths are required');

let privateKeyBytes;
let protectedBytes;
let payloadKey;
let plaintext;
let verificationFailed = false;
try {
  const envelope = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  exactKeys('package root', envelope, ['format', 'protected_b64', 'wrapped_key_b64', 'payload']);
  if (envelope.format !== ENVELOPE_FORMAT) throw new Error('envelope format is unsupported');

  protectedBytes = decodeBase64('protected_b64', envelope.protected_b64, 2);
  const wrappedKey = decodeBase64('wrapped_key_b64', envelope.wrapped_key_b64, 256);
  exactKeys('payload envelope', envelope.payload, ['nonce_b64', 'auth_tag_b64', 'ciphertext_b64']);
  const nonce = decodeBase64('nonce_b64', envelope.payload.nonce_b64, 12);
  const authTag = decodeBase64('auth_tag_b64', envelope.payload.auth_tag_b64, 16);
  const ciphertext = decodeBase64('ciphertext_b64', envelope.payload.ciphertext_b64, 2);
  if (nonce.length !== 12 || authTag.length !== 16) throw new Error('AES-GCM parameters are invalid');

  privateKeyBytes = fs.readFileSync(privateKeyPath);
  const privateKey = crypto.createPrivateKey(privateKeyBytes);
  if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error('recipient key must be an RSA private key with at least 2048 bits');
  }
  const publicDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  payloadKey = crypto.privateDecrypt({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
    oaepLabel: OAEP_LABEL,
  }, wrappedKey);
  if (payloadKey.length !== 32) throw new Error('unwrapped payload key length is invalid');

  const decipher = crypto.createDecipheriv('aes-256-gcm', payloadKey, nonce, { authTagLength: 16 });
  decipher.setAAD(protectedBytes);
  decipher.setAuthTag(authTag);
  plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  const protectedMetadata = JSON.parse(protectedBytes.toString('utf8'));
  exactKeys('protected metadata', protectedMetadata, [
    'schema_version', 'envelope_format', 'export_format', 'created_at',
    'snapshot_created_at', 'export_run', 'recipient_public_key_sha256',
    'source_database_sha256', 'export_plaintext_sha256', 'counts', 'crypto',
  ]);
  if (protectedMetadata.schema_version !== 2) throw new Error('protected metadata schema is unsupported');
  if (protectedMetadata.envelope_format !== ENVELOPE_FORMAT || protectedMetadata.export_format !== EXPORT_FORMAT) {
    throw new Error('protected format identifiers are invalid');
  }
  requireTimestamp('protected created_at', protectedMetadata.created_at);
  requireTimestamp('protected snapshot_created_at', protectedMetadata.snapshot_created_at);
  exactKeys('protected export run', protectedMetadata.export_run, [
    'provider', 'repository', 'run_id', 'run_attempt', 'workflow_commit',
  ]);
  if (protectedMetadata.export_run.provider !== 'github_actions') throw new Error('export run provider is invalid');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(protectedMetadata.export_run.repository)) {
    throw new Error('export repository is invalid');
  }
  if (!/^[1-9][0-9]{0,19}$/.test(protectedMetadata.export_run.run_id)) throw new Error('export run id is invalid');
  if (!Number.isSafeInteger(protectedMetadata.export_run.run_attempt) || protectedMetadata.export_run.run_attempt < 1) {
    throw new Error('export run attempt is invalid');
  }
  if (protectedMetadata.export_run.run_attempt > 9_999_999_999) throw new Error('export run attempt is too large');
  if (!/^[0-9a-f]{40}$/.test(protectedMetadata.export_run.workflow_commit)) {
    throw new Error('export workflow commit is invalid');
  }
  if (!isSha256(protectedMetadata.recipient_public_key_sha256)
      || protectedMetadata.recipient_public_key_sha256 !== sha256(publicDer)) {
    throw new Error('recipient public key fingerprint does not match');
  }
  if (!isSha256(protectedMetadata.source_database_sha256)) throw new Error('source database hash is invalid');
  if (!isSha256(protectedMetadata.export_plaintext_sha256)
      || protectedMetadata.export_plaintext_sha256 !== sha256(plaintext)) {
    throw new Error('plaintext hash does not match');
  }
  validateCounts(protectedMetadata.counts);
  exactKeys('protected crypto', protectedMetadata.crypto, [
    'payload_algorithm', 'key_wrap_algorithm', 'key_wrap_label_b64',
  ]);
  if (protectedMetadata.crypto.payload_algorithm !== 'AES-256-GCM'
      || protectedMetadata.crypto.key_wrap_algorithm !== 'RSA-OAEP-SHA256'
      || protectedMetadata.crypto.key_wrap_label_b64 !== OAEP_LABEL.toString('base64')) {
    throw new Error('protected crypto metadata is invalid');
  }

  const migration = JSON.parse(plaintext.toString('utf8'));
  exactKeys('migration payload', migration, ['format', 'exported_at', 'source', 'users', 'provider', 'codex_relay']);
  if (migration.format !== EXPORT_FORMAT || migration.exported_at !== protectedMetadata.created_at) {
    throw new Error('payload export identity does not match protected metadata');
  }
  exactKeys('payload source', migration.source, ['snapshot_kind', 'snapshot_created_at', 'database_sha256', 'export_run']);
  if (migration.source.snapshot_kind !== 'fresh_maintenance_snapshot'
      || migration.source.snapshot_created_at !== protectedMetadata.snapshot_created_at
      || migration.source.database_sha256 !== protectedMetadata.source_database_sha256) {
    throw new Error('payload snapshot identity does not match protected metadata');
  }
  if (JSON.stringify(migration.source.export_run) !== JSON.stringify(protectedMetadata.export_run)) {
    throw new Error('payload run identity does not match protected metadata');
  }
  if (Date.parse(migration.exported_at) < Date.parse(migration.source.snapshot_created_at)) {
    throw new Error('payload export timestamp predates the snapshot');
  }
  if (!Array.isArray(migration.users)) throw new Error('users collection is invalid');
  exactKeys('provider collection', migration.provider, ['api_keys', 'models']);
  exactKeys('relay collection', migration.codex_relay, ['groups', 'group_models', 'sources', 'api_keys', 'models']);
  for (const value of [
    migration.provider.api_keys, migration.provider.models, migration.codex_relay.groups,
    migration.codex_relay.group_models, migration.codex_relay.sources,
    migration.codex_relay.api_keys, migration.codex_relay.models,
  ]) if (!Array.isArray(value)) throw new Error('migration collection is invalid');
  if (JSON.stringify(actualCounts(migration)) !== JSON.stringify(protectedMetadata.counts)) {
    throw new Error('authenticated counts do not match decrypted collections');
  }

  process.stdout.write(`${JSON.stringify({
    verified: true,
    format: protectedMetadata.export_format,
    created_at: protectedMetadata.created_at,
    snapshot_created_at: protectedMetadata.snapshot_created_at,
    export_run: protectedMetadata.export_run,
    recipient_public_key_sha256: protectedMetadata.recipient_public_key_sha256,
    source_database_sha256: protectedMetadata.source_database_sha256,
    counts: protectedMetadata.counts,
  }, null, 2)}\n`);
} catch {
  verificationFailed = true;
} finally {
  privateKeyBytes?.fill(0);
  protectedBytes?.fill(0);
  payloadKey?.fill(0);
  plaintext?.fill(0);
}
if (verificationFailed) fail('authentication, decryption, or payload validation failed');
