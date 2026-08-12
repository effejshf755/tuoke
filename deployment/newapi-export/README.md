# Encrypted NewAPI migration export

This directory contains only the migration workstation's RSA public key at:

```text
deployment/newapi-export/recipient-public-key.pem
```

Requirements:

- Public key only; never commit a private key.
- PEM type must be `PUBLIC KEY` (SubjectPublicKeyInfo).
- RSA, at least 2048 bits; RSA-3072 or RSA-4096 is recommended.
- Keep the private key offline on the local migration workstation.

Generate a new RSA-4096 recipient pair locally:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out recipient-private-key.pem
openssl pkey -in recipient-private-key.pem -pubout -out recipient-public-key.pem
```

The private key must not be added to this repository, GitHub Actions, the
production server, logs, or artifacts. The export can only be started manually
with `workflow_dispatch`, and requires the exact confirmation phrase
`EXPORT_FRESH_MAINTENANCE_SNAPSHOT`.

After confirming that the live database is in maintenance mode, the export
creates a fresh online SQLite snapshot for that GitHub Actions run. The source
volume is mounted read-only and SQLite `query_only` is enabled. The snapshot
is normalized to a self-contained rollback-journal file and checked with
`quick_check`. It exists only beneath
`/root/tuoke-newapi-export-tmp`, and the shell exit trap removes both the
snapshot and production-side ciphertext temporary file.

The generated artifact contains:

- one RSA-wrapped, AES-256-GCM encrypted JSON export;
- one transport manifest containing only package sizes and a package checksum.

No plaintext JSON export is written to the production host or Actions runner.
The production host holds only the short-lived SQLite snapshot described above;
the exit trap deletes it. Counts, source hashes, timestamps, run identity,
algorithms, and the recipient fingerprint are all authenticated as AES-GCM
additional data. The transport manifest is not authenticated and must never
drive import decisions.

Verify a downloaded package locally before importing it:

```bash
node scripts/verify-production-newapi-export.mjs package.enc.json recipient-private-key.pem
```

The verifier decrypts only in process memory and emits a safe summary. Import
code must independently decrypt and validate the same authenticated metadata;
it must ignore the transport manifest for all migration decisions.
