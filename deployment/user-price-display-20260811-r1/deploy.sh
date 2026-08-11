#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER="tuoke-prod-freellmapi-1"
COMPOSE_FILE="/srv/tuoke-prod/docker-compose.yml"
COMPOSE_PROJECT="tuoke-prod"
COMPOSE_SERVICE="freellmapi"
DATA_VOLUME="tuoke-prod_freellmapi-data"
PUBLIC_ORIGIN="https://tuokeapi.com"
EXPECTED_COMPOSE_HASH="57a5b40618171a37c61b5c196437a13e61f246f886c3eebe96e8e8eb8c25edcc"
EXPECTED_BASE_IMAGE="migration-japan/tuokeapi:20260811-admin-users-real-token-r2"
EXPECTED_BASE_IMAGE_ID="sha256:490814758d792e5f7538b062ff9eddc5d5676a125f4ee41ef4ce072af44e0496"
EXPECTED_BASE_RELEASE="admin-users-real-token-20260811-r2"
RELEASE_LABEL="user-price-display-20260811-r1"
NEW_IMAGE="migration-japan/tuokeapi:20260811-user-price-display-r1"
CLIENT_JS="index-recharge-expiry-r1.js"
CLIENT_CSS="index-Cbkhjyuo.css"
OLD_ROUTE_SHA256="49de4045200eae7b56e0b90b146a8539fc7cea20c7369ce2087cf8193a4208bf"
NEW_ROUTE_SHA256="cba59837768079bde55dad154ee0a520b4236dc41ce6c3e8ec962ca578beaad1"
OLD_SERVICE_SHA256="6f2ddcebe8f0ad285c4bcbda07079044dc914e4347bdd7ac261a64572d43267e"
NEW_SERVICE_SHA256="009bcbead8f6a8eab1248dbbcfba7f2c8392214d67b18b5a06e7f171d600f38d"

RELEASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/root/deploy-backups/${RELEASE_LABEL}-${STAMP}"

stage() { printf 'deployment_stage=%s\n' "$1"; }

stage lock
exec 9>/var/lock/tuoke-api-deploy.lock
flock -n 9 || { echo "deployment_lock=busy" >&2; exit 75; }

stage release_validation
test "$(id -u)" -eq 0
test -f "$COMPOSE_FILE"
test -f "$RELEASE_DIR/Dockerfile"
test -f "$RELEASE_DIR/MANIFEST.sha256"
test -s "$RELEASE_DIR/server-dist/routes/consumer-api-keys.js"
test -s "$RELEASE_DIR/server-dist/services/consumer-codex-groups.js"
(cd "$RELEASE_DIR" && sha256sum -c MANIFEST.sha256)

docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" config -q
mapfile -t COMPOSE_IMAGES < <(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" config --images)
test "${#COMPOSE_IMAGES[@]}" -eq 1
test "${COMPOSE_IMAGES[0]}" = "$EXPECTED_BASE_IMAGE"
COMPOSE_HASH="$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
test "$COMPOSE_HASH" = "$EXPECTED_COMPOSE_HASH"

docker inspect "$CONTAINER" >/dev/null
test "$(docker inspect --format '{{.State.Status}}' "$CONTAINER")" = "running"
BASE_HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")"
test "$BASE_HEALTH" != "unhealthy"
OLD_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")"
OLD_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER")"
OLD_RELEASE="$(docker image inspect --format '{{index .Config.Labels "tuoke.release"}}' "$OLD_IMAGE")"
test "$OLD_IMAGE" = "$EXPECTED_BASE_IMAGE"
test "$OLD_IMAGE_ID" = "$EXPECTED_BASE_IMAGE_ID"
test "$OLD_RELEASE" = "$EXPECTED_BASE_RELEASE"
test "$(docker image inspect --format '{{.Id}}' "$OLD_IMAGE")" = "$OLD_IMAGE_ID"
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER")" = "$COMPOSE_PROJECT"
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$CONTAINER")" = "$COMPOSE_SERVICE"
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$CONTAINER")" = "$COMPOSE_FILE"
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$CONTAINER")" = "/srv/tuoke-prod"
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/server/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER")" = "$DATA_VOLUME"

assert_live_baseline() {
  test "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$COMPOSE_HASH"
  mapfile -t current_compose_images < <(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" config --images)
  test "${#current_compose_images[@]}" -eq 1
  test "${current_compose_images[0]}" = "$OLD_IMAGE"
  test "$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")" = "$OLD_IMAGE"
  test "$(docker inspect --format '{{.Image}}' "$CONTAINER")" = "$OLD_IMAGE_ID"
  test "$(docker image inspect --format '{{.Id}}' "$OLD_IMAGE")" = "$OLD_IMAGE_ID"
  test "$(docker image inspect --format '{{index .Config.Labels "tuoke.release"}}' "$OLD_IMAGE")" = "$EXPECTED_BASE_RELEASE"
}

assert_live_baseline
docker exec "$CONTAINER" sh -lc "
  set -eu
  echo '$OLD_ROUTE_SHA256  /app/server/dist/routes/consumer-api-keys.js' | sha256sum -c -
  echo '$OLD_SERVICE_SHA256  /app/server/dist/services/consumer-codex-groups.js' | sha256sum -c -
  echo 'ef69a9d53e74b1081505d6815b6b8e445019f46e1c1a13fc4d9fe36f88c626fa  /app/client/dist/index.html' | sha256sum -c -
  echo '76ab04b5aa702fbfb5c1a1fe5af372eb797e0e7064937378e1e33c6d532ba04f  /app/client/dist/assets/$CLIENT_JS' | sha256sum -c -
  echo '6f2741eaf5c5e4d3cb0ec87688a4141ae47b97bb3052b91cb00422d31f1b6a9c  /app/client/dist/assets/$CLIENT_CSS' | sha256sum -c -
"

stage backup
install -d -m 0700 "$BACKUP_DIR"
cp -a "$COMPOSE_FILE" "$BACKUP_DIR/docker-compose.yml.before"
chmod 0600 "$BACKUP_DIR/docker-compose.yml.before"
docker inspect "$CONTAINER" > "$BACKUP_DIR/container-inspect.before.json"
docker volume inspect "$DATA_VOLUME" > "$BACKUP_DIR/data-volume.before.json"
printf '%s\n' "$OLD_IMAGE" > "$BACKUP_DIR/previous-image.txt"
printf '%s\n' "$OLD_IMAGE_ID" > "$BACKUP_DIR/previous-image-id.txt"
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

stage isolated_price_display_test
docker run --rm -i \
  --env ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  --entrypoint node \
  "$NEW_IMAGE" \
  --input-type=module - <<'NODE'
import { initDb, getDb } from "/app/server/dist/db/index.js";
import { createUser, createSession } from "/app/server/dist/services/auth.js";
import { applyUserBillingMultiplier } from "/app/server/dist/services/billing.js";
import { createApp } from "/app/server/dist/app.js";

initDb(":memory:");
const user = createUser("display-price-user@example.test", "password123");
const db = getDb();
const modelId = "gpt-5.6-sol";
const groupId = Number(db.prepare(`
  INSERT INTO codex_groups (name, description, enabled, multiplier_milli)
  VALUES ('Display price test', 'isolated', 1, 2000)
`).run().lastInsertRowid);
db.prepare(`
  INSERT INTO codex_group_models (
    group_id, model_id, input_price_micro_per_million_override,
    output_price_micro_per_million_override, multiplier_milli_override,
    cached_input_multiplier_milli_override
  ) VALUES (?, ?, 3000000, 10000000, 500, 100)
`).run(groupId, modelId);
const relayKeyId = Number(db.prepare(`
  INSERT INTO api_keys (
    platform, role, label, encrypted_key, iv, auth_tag,
    status, enabled, base_url
  ) VALUES ('custom', 'codex_relay', 'display-price-relay', 'x', 'x', 'x', 'unknown', 1, 'https://relay.example/v1')
`).run().lastInsertRowid);
const sourceId = Number(db.prepare(`
  INSERT INTO codex_relay_sources (
    api_key_id, name, codex_group_id, protocol, enabled, status, priority
  ) VALUES (?, 'Display price relay', ?, 'responses', 1, 'unknown', 100)
`).run(relayKeyId, groupId).lastInsertRowid);
db.prepare(`
  INSERT INTO codex_relay_source_keys (source_id, api_key_id, label, enabled, status)
  VALUES (?, ?, 'display-price-relay', 1, 'unknown')
`).run(sourceId, relayKeyId);
db.prepare(`
  INSERT INTO codex_relay_source_models
    (source_id, public_model_id, upstream_model_id, enabled, supports_tools, supports_vision)
  VALUES (?, ?, ?, 1, 1, 0)
`).run(sourceId, modelId, modelId);

const app = createApp();
const server = await new Promise((resolve) => {
  const running = app.listen(0, "127.0.0.1", () => resolve(running));
});
const token = createSession(user.userId);
async function readPricing() {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/consumer-keys/codex-groups`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  const group = body.groups?.find((entry) => entry.id === groupId);
  if (response.status !== 200 || !group?.selectable || group.modelPricing?.length !== 1) {
    throw new Error(`display pricing endpoint failed: ${JSON.stringify({ status: response.status, group })}`);
  }
  return group.modelPricing[0];
}
try {
  db.prepare('UPDATE users SET billing_multiplier_milli = 0 WHERE id = ?').run(user.userId);
  const zeroPricing = await readPricing();
  if (JSON.stringify(zeroPricing) !== JSON.stringify({
    modelId,
    inputPricePerMillion: 1.5,
    cachedInputPricePerMillion: 0.15,
    outputPricePerMillion: 5,
    effectiveMultiplier: 0.5,
  })) throw new Error(`unexpected normal display price: ${JSON.stringify(zeroPricing)}`);
  db.prepare('UPDATE users SET billing_multiplier_milli = 1500 WHERE id = ?').run(user.userId);
  const customPricing = await readPricing();
  if (JSON.stringify(customPricing) !== JSON.stringify(zeroPricing)) {
    throw new Error(`personal multiplier leaked into display: ${JSON.stringify({ zeroPricing, customPricing })}`);
  }
  if (applyUserBillingMultiplier(db, user.userId, 500) !== 750) {
    throw new Error('personal multiplier no longer affects settlement');
  }
  console.log('isolated_public_price_contract=ok');
  console.log('isolated_billing_multiplier_contract=ok');
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
    for (const name of ["input_tokens", "output_tokens", "input_compute_points", "output_compute_points"]) {
      if (!columns.has(name)) throw new Error(`missing requests column: ${name}`);
    }
    db.close();
    console.log("candidate_live_usage_schema=ok");
  '

# Refuse to switch if another deployment changed production during the build.
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
          fetch("http://127.0.0.1:3001/api/ping")
            .then(async response => {
              const body = await response.json();
              if (!response.ok || body.status !== "ok") process.exit(1);
            })
            .catch(() => process.exit(1));
        ' >/dev/null 2>&1; then
        rollback_ok=1
        break
      fi
      sleep 2
    done
    if [ "$rollback_ok" -eq 1 ]; then
      echo "deployment_result=rolled_back" >&2
    else
      echo "deployment_result=rollback_failed" >&2
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
  if [ "$STATUS" = "running" ] && { [ "$HEALTH" = "healthy" ] || [ "$HEALTH" = "none" ]; }; then
    if docker exec "$CONTAINER" node -e '
      fetch("http://127.0.0.1:3001/api/ping")
        .then(async response => {
          const body = await response.json();
          if (!response.ok || body.status !== "ok") process.exit(1);
        })
        .catch(() => process.exit(1));
    ' >/dev/null 2>&1; then
      HEALTH_OK=1
      break
    fi
  fi
  if [ "$STATUS" = "exited" ] || [ "$STATUS" = "dead" ]; then
    break
  fi
  sleep 2
done
test "$HEALTH_OK" -eq 1

test "$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")" = "$NEW_IMAGE"
test "$(docker inspect --format '{{.Image}}' "$CONTAINER")" = "$NEW_IMAGE_ID"
test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")" != "unhealthy"
test "$(docker image inspect --format '{{index .Config.Labels "tuoke.release"}}' "$NEW_IMAGE")" = "$RELEASE_LABEL"

docker exec "$CONTAINER" sh -lc "
  set -eu
  echo '$NEW_ROUTE_SHA256  /app/server/dist/routes/consumer-api-keys.js' | sha256sum -c -
  echo '$NEW_SERVICE_SHA256  /app/server/dist/services/consumer-codex-groups.js' | sha256sum -c -
  test ! -e /app/server/dist/routes/consumer-api-keys.js.map
  test ! -e /app/server/dist/services/consumer-codex-groups.js.map
  node --check /app/server/dist/routes/consumer-api-keys.js
  node --check /app/server/dist/services/consumer-codex-groups.js
  ! grep -Fq 'getUserBillingMultiplierMilli' /app/server/dist/services/consumer-codex-groups.js
  echo 'ef69a9d53e74b1081505d6815b6b8e445019f46e1c1a13fc4d9fe36f88c626fa  /app/client/dist/index.html' | sha256sum -c -
  echo '76ab04b5aa702fbfb5c1a1fe5af372eb797e0e7064937378e1e33c6d532ba04f  /app/client/dist/assets/$CLIENT_JS' | sha256sum -c -
  echo '6f2741eaf5c5e4d3cb0ec87688a4141ae47b97bb3052b91cb00422d31f1b6a9c  /app/client/dist/assets/$CLIENT_CSS' | sha256sum -c -
"

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
      fetch('$PUBLIC_ORIGIN/', { cache: 'no-store' }).then(async response => {
        const html = await response.text();
        if (!response.ok || !html.includes('/assets/$CLIENT_JS') || !html.includes('/assets/$CLIENT_CSS')) {
          throw new Error('public client assets are stale');
        }
      }),
    ]).catch(() => process.exit(1));
  " >/dev/null 2>&1; then
    PUBLIC_OK=1
    break
  fi
  sleep 2
done
test "$PUBLIC_OK" -eq 1
test "$(docker inspect --format '{{.RestartCount}}' "$CONTAINER")" = "0"

SWITCH_STARTED=0
trap - ERR HUP INT TERM
echo "deployment_result=ok"
echo "deployment_mode=verified_user_price_display_overlay"
echo "backup_dir=$BACKUP_DIR"
echo "previous_image=$OLD_IMAGE"
echo "previous_image_id=$OLD_IMAGE_ID"
echo "new_image=$NEW_IMAGE"
echo "new_image_id=$NEW_IMAGE_ID"
