#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

RELEASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_LABEL='user-usage-privacy-20260812-r1'
NEW_IMAGE='migration-japan/tuokeapi:20260812-user-usage-privacy-r1'
COMPOSE_FILE='/srv/tuoke-prod/docker-compose.yml'
COMPOSE_PROJECT='tuoke-prod'
COMPOSE_SERVICE='freellmapi'
CONTAINER='tuoke-prod-freellmapi-1'
DATA_VOLUME='tuoke-prod_freellmapi-data'
PUBLIC_ORIGIN='https://tuokeapi.com'
CLIENT_JS='index-user-usage-privacy-r1.js'
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/root/tuoke-backups/${RELEASE_LABEL}-${STAMP}"

stage() { printf 'stage=%s\n' "$1"; }

stage lock
exec 9>/var/lock/tuoke-api-deploy.lock
flock -n 9 || { echo 'deployment_lock=busy' >&2; exit 75; }

stage release_validation
test "$(id -u)" -eq 0
test -f "$COMPOSE_FILE"
test -f "$RELEASE_DIR/Dockerfile"
test -f "$RELEASE_DIR/apply-runtime-patch.mjs"
test -f "$RELEASE_DIR/MANIFEST.sha256"
test -f "$RELEASE_DIR/RELEASE.txt"
(cd "$RELEASE_DIR" && sha256sum -c MANIFEST.sha256)

docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" config -q
mapfile -t COMPOSE_IMAGES < <(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" config --images)
test "${#COMPOSE_IMAGES[@]}" -eq 1
COMPOSE_HASH="$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"

docker inspect "$CONTAINER" >/dev/null
test "$(docker inspect --format '{{.State.Status}}' "$CONTAINER")" = running
BASE_HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")"
test "$BASE_HEALTH" != unhealthy
OLD_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")"
OLD_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER")"
OLD_RELEASE="$(docker image inspect --format '{{index .Config.Labels "tuoke.release"}}' "$OLD_IMAGE")"
test -n "$OLD_IMAGE"
test -n "$OLD_IMAGE_ID"
test -n "$OLD_RELEASE"
test "$OLD_IMAGE" != "$NEW_IMAGE"
test "$(docker image inspect --format '{{.Id}}' "$OLD_IMAGE")" = "$OLD_IMAGE_ID"
test "${COMPOSE_IMAGES[0]}" = "$OLD_IMAGE"
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER")" = "$COMPOSE_PROJECT"
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$CONTAINER")" = "$COMPOSE_SERVICE"
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/server/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER")" = "$DATA_VOLUME"

assert_live_baseline() {
  test "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$COMPOSE_HASH"
  mapfile -t current_images < <(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" config --images)
  test "${#current_images[@]}" -eq 1
  test "${current_images[0]}" = "$OLD_IMAGE"
  test "$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")" = "$OLD_IMAGE"
  test "$(docker inspect --format '{{.Image}}' "$CONTAINER")" = "$OLD_IMAGE_ID"
  test "$(docker image inspect --format '{{.Id}}' "$OLD_IMAGE")" = "$OLD_IMAGE_ID"
}

assert_live_baseline
docker exec "$CONTAINER" sh -lc '
  set -eu
  test -s /app/server/data/freeapi.db
  test -s /app/server/dist/routes/user.js
  test -s /app/server/dist/routes/user-analytics.js
  test -s /app/server/dist/routes/user-wallet.js
  test -s /app/server/dist/routes/fallback.js
  test -s /app/server/dist/services/consumer-api-keys.js
  test -s /app/server/dist/services/resource-user.js
  test -s /app/client/dist/index.html
  grep -Fq "input_compute_points" /app/server/dist/routes/user.js
  grep -Fq "input_compute_points" /app/server/dist/routes/user-analytics.js
  grep -Fq "LEFT JOIN requests r" /app/server/dist/routes/user-wallet.js
  grep -Fq "input_compute_points" /app/server/dist/services/consumer-api-keys.js
  grep -Fq "input_compute_points" /app/server/dist/services/resource-user.js
'

stage backup
install -d -m 0700 "$BACKUP_DIR"
cp -a "$COMPOSE_FILE" "$BACKUP_DIR/docker-compose.yml.before"
chmod 0600 "$BACKUP_DIR/docker-compose.yml.before"
docker inspect "$CONTAINER" > "$BACKUP_DIR/container-inspect.before.json"
docker volume inspect "$DATA_VOLUME" > "$BACKUP_DIR/data-volume.before.json"
printf '%s\n' "$OLD_IMAGE" > "$BACKUP_DIR/previous-image.txt"
printf '%s\n' "$OLD_IMAGE_ID" > "$BACKUP_DIR/previous-image-id.txt"
printf '%s\n' "$OLD_RELEASE" > "$BACKUP_DIR/previous-release.txt"
sha256sum "$COMPOSE_FILE" > "$BACKUP_DIR/docker-compose.yml.before.sha256"

CONTAINER_DB_BACKUP="/app/server/data/.deploy-backup-${STAMP}.db"
docker exec "$CONTAINER" node --input-type=module -e '
  import Database from "better-sqlite3";
  const target = process.argv[1];
  const source = new Database("/app/server/data/freeapi.db", { readonly: true, fileMustExist: true });
  await source.backup(target);
  source.close();
  const copy = new Database(target, { readonly: true, fileMustExist: true });
  const result = copy.pragma("quick_check", { simple: true });
  copy.close();
  if (result !== "ok") throw new Error(`backup quick_check failed: ${result}`);
' "$CONTAINER_DB_BACKUP"
docker cp "$CONTAINER:$CONTAINER_DB_BACKUP" "$BACKUP_DIR/freeapi-before.db"
docker exec "$CONTAINER" rm -f -- "$CONTAINER_DB_BACKUP"
test -s "$BACKUP_DIR/freeapi-before.db"
sha256sum "$BACKUP_DIR/freeapi-before.db" > "$BACKUP_DIR/freeapi-before.db.sha256"

stage candidate_build
docker build \
  --pull=false \
  --build-arg "BASE_IMAGE=$OLD_IMAGE" \
  --build-arg "BASE_IMAGE_ID=$OLD_IMAGE_ID" \
  --build-arg "BASE_RELEASE=$OLD_RELEASE" \
  --tag "$NEW_IMAGE" \
  "$RELEASE_DIR"

test "$(docker image inspect --format '{{index .Config.Labels "tuoke.release"}}' "$NEW_IMAGE")" = "$RELEASE_LABEL"
test "$(docker image inspect --format '{{index .Config.Labels "tuoke.expected-base"}}' "$NEW_IMAGE")" = "$OLD_IMAGE"
test "$(docker image inspect --format '{{index .Config.Labels "tuoke.expected-base-id"}}' "$NEW_IMAGE")" = "$OLD_IMAGE_ID"
NEW_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$NEW_IMAGE")"
test -n "$NEW_IMAGE_ID"

stage isolated_usage_privacy_test
docker run --rm -i \
  --env ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  --entrypoint node \
  "$NEW_IMAGE" \
  --input-type=module - <<'NODE'
import { initDb, getDb } from "/app/server/dist/db/index.js";
import { createUser, createSession } from "/app/server/dist/services/auth.js";
import { createApp } from "/app/server/dist/app.js";

initDb(":memory:");
const admin = createUser("privacy-admin@example.test", "password123");
const user = createUser("privacy-user@example.test", "password123");
const adminToken = createSession(admin.userId);
const userToken = createSession(user.userId);
const db = getDb();
const groupId = Number(db.prepare(`INSERT INTO codex_groups (name, description) VALUES ('Privacy group', 'isolated')`).run().lastInsertRowid);
const keyId = Number(db.prepare(`
  INSERT INTO consumer_api_keys (user_id, name, key_prefix, key_hash, codex_group_id)
  VALUES (?, 'Privacy key', 'tk-privacy', 'privacy-key-hash', ?)
`).run(user.userId, groupId).lastInsertRowid);

const goodRequestId = Number(db.prepare(`
  INSERT INTO requests (
    platform, model_id, key_id, status, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
    input_compute_points, output_compute_points, compute_points_per_million_tokens,
    consumer_user_id, consumer_api_key_id, billing_amount_micro, billing_status, user_visible
  ) VALUES ('openai-codex', 'gpt-test', 0, 'success', 11, 3, 2, 7, 55, 35, 5000000, ?, ?, 1, 'charged', 1)
`).run(user.userId, keyId).lastInsertRowid);
const legacyRequestId = Number(db.prepare(`
  INSERT INTO requests (
    platform, model_id, key_id, status, input_tokens, cached_input_tokens, output_tokens,
    input_compute_points, output_compute_points, compute_points_per_million_tokens,
    consumer_user_id, consumer_api_key_id, user_visible
  ) VALUES ('openai-codex', 'legacy-test', 0, 'success', 987654321, 123456789, 456789123, 0, 0, 0, ?, ?, 1)
`).run(user.userId, keyId).lastInsertRowid);
db.prepare(`
  INSERT INTO wallet_transactions (
    user_id, type, delta_micro, balance_after_micro, request_id,
    platform, model_id, input_tokens, cached_input_tokens, output_tokens
  ) VALUES (?, 'usage', -1, 0, ?, 'openai-codex', 'gpt-test', 11, 3, 7)
`).run(user.userId, goodRequestId);
db.prepare(`
  INSERT INTO wallet_transactions (
    user_id, type, delta_micro, balance_after_micro, request_id,
    platform, model_id, input_tokens, cached_input_tokens, output_tokens
  ) VALUES (?, 'usage', -1, 0, ?, 'openai-codex', 'legacy-test', 987654321, 123456789, 456789123)
`).run(user.userId, legacyRequestId);
const conversationId = Number(db.prepare(`
  INSERT INTO playground_conversations (user_id, title, model_id)
  VALUES (?, 'privacy', 'gpt-test')
`).run(user.userId).lastInsertRowid);
db.prepare(`
  INSERT INTO playground_messages (
    conversation_id, role, content, prompt_tokens, completion_tokens, total_tokens
  ) VALUES (?, 'assistant', 'ok', 987654321, 456789123, 1444443444)
`).run(conversationId);

const app = createApp();
const server = await new Promise((resolve) => {
  const running = app.listen(0, "127.0.0.1", () => resolve(running));
});
const base = `http://127.0.0.1:${server.address().port}`;
async function read(path, token) {
  const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json();
  return { status: response.status, body };
}
try {
  const usage = await read('/api/user/usage', userToken);
  const history = await read('/api/user/requests?limit=10', userToken);
  const summary = await read('/api/user/analytics/summary?range=7d', userToken);
  const analyticsRows = await read('/api/user/analytics/requests?range=7d&limit=10', userToken);
  const wallet = await read('/api/user/wallet/transactions', userToken);
  const keys = await read('/api/consumer-keys', userToken);
  const playground = await read(`/api/user/playground/conversations/${conversationId}/messages`, userToken);
  const globalUser = await read('/api/fallback/token-usage', userToken);
  const globalAdmin = await read('/api/fallback/token-usage', adminToken);

  if (usage.status !== 200 || usage.body.prompt_tokens !== 55 || usage.body.completion_tokens !== 35 || usage.body.total_tokens !== 90) {
    throw new Error(`usage contract failed: ${JSON.stringify(usage)}`);
  }
  const goodHistory = history.body.requests.find((row) => row.routedModel === 'gpt-test');
  const legacyHistory = history.body.requests.find((row) => row.routedModel === 'legacy-test');
  if (!goodHistory || goodHistory.inputTokens !== 55 || goodHistory.cachedInputTokens !== 15 || goodHistory.outputTokens !== 35) {
    throw new Error(`history compute-point contract failed: ${JSON.stringify(history)}`);
  }
  if (!legacyHistory || legacyHistory.inputTokens !== 0 || legacyHistory.cachedInputTokens !== 0 || legacyHistory.outputTokens !== 0) {
    throw new Error(`history legacy fail-closed contract failed: ${JSON.stringify(history)}`);
  }
  if (summary.body.totalInputTokens !== 55 || summary.body.totalOutputTokens !== 35) {
    throw new Error(`analytics summary contract failed: ${JSON.stringify(summary)}`);
  }
  const legacyAnalytics = analyticsRows.body.rows.find((row) => row.modelId === 'legacy-test');
  if (!legacyAnalytics || legacyAnalytics.inputTokens !== 0 || legacyAnalytics.outputTokens !== 0) {
    throw new Error(`analytics legacy contract failed: ${JSON.stringify(analyticsRows)}`);
  }
  const goodWallet = wallet.body.transactions.find((row) => row.model_id === 'gpt-test');
  const legacyWallet = wallet.body.transactions.find((row) => row.model_id === 'legacy-test');
  if (!goodWallet || goodWallet.input_tokens !== 55 || goodWallet.cached_input_tokens !== 15 || goodWallet.output_tokens !== 35) {
    throw new Error(`wallet compute-point contract failed: ${JSON.stringify(wallet)}`);
  }
  if (!legacyWallet || legacyWallet.input_tokens !== 0 || legacyWallet.cached_input_tokens !== 0 || legacyWallet.output_tokens !== 0) {
    throw new Error(`wallet legacy contract failed: ${JSON.stringify(wallet)}`);
  }
  const key = keys.body.keys.find((row) => row.id === keyId);
  if (!key || key.inputTokens !== 55 || key.outputTokens !== 35 || key.totalTokens !== 90) {
    throw new Error(`API Key usage contract failed: ${JSON.stringify(keys)}`);
  }
  if (playground.body.messages[0].promptTokens !== 0 || playground.body.messages[0].completionTokens !== 0 || playground.body.messages[0].totalTokens !== 0) {
    throw new Error(`Playground privacy contract failed: ${JSON.stringify(playground)}`);
  }
  const serialized = JSON.stringify({ usage, history, summary, analyticsRows, wallet, keys, playground });
  if (serialized.includes('987654321') || serialized.includes('456789123')) {
    throw new Error('raw token sentinel leaked into an ordinary-user response');
  }
  if (globalUser.status !== 403 || globalAdmin.status !== 200) {
    throw new Error(`global usage authorization failed: ${JSON.stringify({ globalUser, globalAdmin })}`);
  }
  console.log('isolated_user_usage_privacy_contract=ok');
  console.log('isolated_global_usage_admin_guard=ok');
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
NODE

stage live_read_only_query
docker run --rm \
  --volume "$DATA_VOLUME:/app/server/data:ro" \
  --entrypoint node \
  "$NEW_IMAGE" \
  --input-type=module -e '
    import Database from "better-sqlite3";
    const db = new Database("/app/server/data/freeapi.db", { readonly: true, fileMustExist: true });
    const result = db.pragma("quick_check", { simple: true });
    if (result !== "ok") throw new Error(`live quick_check failed: ${result}`);
    const columns = new Set(db.prepare("PRAGMA table_info(requests)").all().map((row) => row.name));
    for (const name of ["input_tokens", "output_tokens", "input_compute_points", "output_compute_points", "compute_points_per_million_tokens"]) {
      if (!columns.has(name)) throw new Error(`missing requests column: ${name}`);
    }
    const divergent = db.prepare(`
      SELECT COUNT(*) count
      FROM requests
      WHERE compute_points_per_million_tokens > 0
        AND (input_compute_points != input_tokens OR output_compute_points != output_tokens)
    `).get();
    db.close();
    console.log(`live_divergent_usage_rows=${Number(divergent.count)}`);
  '

assert_live_baseline

SWITCH_STARTED=0
rollback() {
  local code="${1:-$?}"
  local rollback_ok=0
  trap - ERR HUP INT TERM
  set +e
  if [ "$SWITCH_STARTED" -eq 1 ]; then
    cp -a "$BACKUP_DIR/docker-compose.yml.before" "$COMPOSE_FILE"
    chmod 0600 "$COMPOSE_FILE"
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-build --no-deps --force-recreate "$COMPOSE_SERVICE"
    for _ in $(seq 1 30); do
      if test "$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null)" = "$OLD_IMAGE" \
        && test "$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null)" = "$OLD_IMAGE_ID" \
        && docker exec "$CONTAINER" node -e '
          fetch("http://127.0.0.1:3001/api/ping").then(async response => {
            const body = await response.json();
            if (!response.ok || body.status !== "ok") process.exit(1);
          }).catch(() => process.exit(1));
        ' >/dev/null 2>&1; then
        rollback_ok=1
        break
      fi
      sleep 2
    done
    if [ "$rollback_ok" -eq 1 ]; then
      echo deployment_result=rolled_back >&2
    else
      echo deployment_result=rollback_failed >&2
    fi
  fi
  exit "$code"
}
trap 'rollback $?' ERR
trap 'rollback 129' HUP
trap 'rollback 130' INT
trap 'rollback 143' TERM

stage switch
SWITCH_STARTED=1
python3 - "$COMPOSE_FILE" "$NEW_IMAGE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
image = sys.argv[2]
lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
inside = False
replaced = False
for index, line in enumerate(lines):
    if line.startswith("  freellmapi:"):
        inside = True
        continue
    if inside and line.startswith("  ") and not line.startswith("    ") and line.strip():
        break
    if inside and line.startswith("    image:"):
        newline = "\n" if line.endswith("\n") else ""
        lines[index] = f"    image: {image}{newline}"
        replaced = True
        break
if not replaced:
    raise SystemExit("freellmapi image entry not found")
temporary = path.with_suffix(path.suffix + ".codex-new")
temporary.write_text("".join(lines), encoding="utf-8")
temporary.chmod(0o600)
temporary.replace(path)
PY

docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" config -q
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-build --no-deps --force-recreate "$COMPOSE_SERVICE"

stage health_check
HEALTH_OK=0
for _ in $(seq 1 60); do
  STATUS="$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)"
  HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || true)"
  if [ "$STATUS" = running ] && { [ "$HEALTH" = healthy ] || [ "$HEALTH" = none ]; }; then
    if docker exec "$CONTAINER" node -e '
      fetch("http://127.0.0.1:3001/api/ping").then(async response => {
        const body = await response.json();
        if (!response.ok || body.status !== "ok") process.exit(1);
      }).catch(() => process.exit(1));
    ' >/dev/null 2>&1; then
      HEALTH_OK=1
      break
    fi
  fi
  if [ "$STATUS" = exited ] || [ "$STATUS" = dead ]; then break; fi
  sleep 2
done
test "$HEALTH_OK" -eq 1
test "$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")" = "$NEW_IMAGE"
test "$(docker inspect --format '{{.Image}}' "$CONTAINER")" = "$NEW_IMAGE_ID"
test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")" != unhealthy
test "$(docker image inspect --format '{{index .Config.Labels "tuoke.release"}}' "$NEW_IMAGE")" = "$RELEASE_LABEL"
test "$(docker inspect --format '{{.RestartCount}}' "$CONTAINER")" = 0

docker exec -i "$CONTAINER" sh -s <<'LIVE_RUNTIME_CHECK'
  set -eu
  node --check /app/server/dist/routes/user.js
  node --check /app/server/dist/routes/user-analytics.js
  node --check /app/server/dist/routes/user-wallet.js
  node --check /app/server/dist/routes/fallback.js
  node --check /app/server/dist/services/consumer-api-keys.js
  node --check /app/server/dist/services/resource-user.js
  node --check /app/client/dist/assets/index-user-usage-privacy-r1.js
  grep -Fq "/assets/index-user-usage-privacy-r1.js" /app/client/dist/index.html
  ! grep -Fq "ELSE COALESCE(r.input_tokens, 0)" /app/server/dist/routes/user.js
  ! grep -Fq "ELSE COALESCE(r.input_tokens, 0)" /app/server/dist/routes/user-analytics.js
  ! grep -Fq "ELSE COALESCE(wt.input_tokens, 0)" /app/server/dist/routes/user-wallet.js
  ! grep -Fq "r.input_tokens" /app/server/dist/services/consumer-api-keys.js
  ! grep -Fq "r.output_tokens" /app/server/dist/services/consumer-api-keys.js
  grep -Fq 'const inputUsage = `CASE' /app/server/dist/routes/user.js
  grep -Fq 'const inputUsage = `CASE' /app/server/dist/routes/user-analytics.js
  grep -Fq "token-usage" /app/server/dist/routes/fallback.js
  grep -Fq "requireAdmin, (_req, res)" /app/server/dist/routes/fallback.js
LIVE_RUNTIME_CHECK

docker exec "$CONTAINER" node --input-type=module -e '
  import Database from "better-sqlite3";
  const db = new Database("/app/server/data/freeapi.db", { readonly: true, fileMustExist: true });
  const result = db.pragma("quick_check", { simple: true });
  db.close();
  if (result !== "ok") throw new Error(`live quick_check failed: ${result}`);
  console.log("live_database_quick_check=ok");
'

PUBLIC_OK=0
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" node -e "
    Promise.all([
      fetch('$PUBLIC_ORIGIN/api/ping', { cache: 'no-store' }).then(async response => {
        const body = await response.json();
        if (!response.ok || body.status !== 'ok') throw new Error('public ping failed');
      }),
      fetch('$PUBLIC_ORIGIN/?v=$STAMP', { cache: 'no-store' }).then(async response => {
        const html = await response.text();
        if (!response.ok || !html.includes('/assets/$CLIENT_JS')) throw new Error('public client is stale');
      }),
      fetch('$PUBLIC_ORIGIN/assets/$CLIENT_JS?v=$STAMP', { cache: 'no-store' }).then(async response => {
        const body = await response.text();
        if (!response.ok || !body.includes('TUOKE_USER_USAGE_PRIVACY_R1')) throw new Error('public privacy bundle is stale');
      }),
    ]).catch(() => process.exit(1));
  " >/dev/null 2>&1; then
    PUBLIC_OK=1
    break
  fi
  sleep 2
done
test "$PUBLIC_OK" -eq 1

SWITCH_STARTED=0
trap - ERR HUP INT TERM
echo deployment_result=ok
echo deployment_mode=verified_user_usage_privacy_overlay
echo "backup_dir=$BACKUP_DIR"
echo "previous_image=$OLD_IMAGE"
echo "previous_image_id=$OLD_IMAGE_ID"
echo "new_image=$NEW_IMAGE"
echo "new_image_id=$NEW_IMAGE_ID"
