import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [inputPath, outputPath] = process.argv.slice(2);

function fail(message) {
  console.error(`encrypted export transport validation failed: ${message}`);
  process.exit(1);
}

if (!inputPath || !outputPath) fail('input and output paths are required');

let raw;
let envelope;
try {
  raw = fs.readFileSync(inputPath);
  envelope = JSON.parse(raw.toString('utf8'));
} catch {
  fail('package is not valid JSON');
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const decodeBase64 = (name, value, minimumBytes = 1) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(`${name} is not base64`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < minimumBytes || decoded.toString('base64') !== value) fail(`${name} is not canonical base64`);
  return decoded;
};

const exactKeys = (name, value, expected) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} is invalid`);
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail(`${name} fields are invalid`);
};

exactKeys('package root', envelope, ['format', 'protected_b64', 'wrapped_key_b64', 'payload']);
if (envelope.format !== 'tuoke-newapi-export-envelope/v2') fail('envelope format is unsupported');
const protectedBytes = decodeBase64('protected_b64', envelope.protected_b64, 2);
decodeBase64('wrapped_key_b64', envelope.wrapped_key_b64, 256);
exactKeys('payload', envelope.payload, ['nonce_b64', 'auth_tag_b64', 'ciphertext_b64']);
const nonce = decodeBase64('nonce_b64', envelope.payload.nonce_b64, 12);
const authTag = decodeBase64('auth_tag_b64', envelope.payload.auth_tag_b64, 16);
const ciphertext = decodeBase64('ciphertext_b64', envelope.payload.ciphertext_b64, 2);
if (nonce.length !== 12) fail('AES-GCM nonce length is invalid');
if (authTag.length !== 16) fail('AES-GCM authentication tag length is invalid');

// This public file is deliberately transport-only. protected_b64 is parsed and
// trusted only by the private-key verifier after AES-GCM authentication.
const transportManifest = {
  format: 'tuoke-newapi-export-transport-manifest/v1',
  package_filename: path.basename(inputPath),
  package_bytes: raw.length,
  package_sha256: sha256(raw),
  protected_bytes: protectedBytes.length,
  ciphertext_bytes: ciphertext.length,
  authentication_status: 'requires_private_key_verification',
};

fs.writeFileSync(outputPath, `${JSON.stringify(transportManifest, null, 2)}\n`, { mode: 0o600 });
console.log('encrypted_export_transport=structurally_valid');
