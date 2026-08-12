#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CONTAINER='tuoke-prod-freellmapi-1'
DATA_VOLUME='tuoke-prod_freellmapi-data'
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/root/tuoke-backups/maintenance-${STAMP}"
INDEX_PATH='/app/client/dist/index.html'
DB_PATH='/app/server/data/freeapi.db'
MARKER='TUOKE_PRODUCTION_MAINTENANCE_20260812'

stage() { printf 'stage=%s\n' "$1"; }

stage=preflight
stage "$stage"
test "$(id -u)" -eq 0
docker inspect "$CONTAINER" >/dev/null
test "$(docker inspect --format '{{.State.Status}}' "$CONTAINER")" = running
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/server/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER")" = "$DATA_VOLUME"
docker exec "$CONTAINER" test -s "$DB_PATH"
docker exec "$CONTAINER" test -s "$INDEX_PATH"

stage=backup
stage "$stage"
install -d -m 0700 "$BACKUP_DIR"
docker cp "$CONTAINER:$INDEX_PATH" "$BACKUP_DIR/index.html.before"
chmod 0600 "$BACKUP_DIR/index.html.before"
PREVIOUS_VALUE="$(docker exec -i "$CONTAINER" node --input-type=module - <<'NODE'
import Database from 'better-sqlite3';
const db = new Database('/app/server/data/freeapi.db', { readonly: true, fileMustExist: true });
const previous = db.prepare("SELECT value FROM settings WHERE key='maintenance_mode'").get()?.value ?? null;
db.close();
process.stdout.write(previous === null ? '__NULL__' : String(previous));
NODE
)"
case "$PREVIOUS_VALUE" in
  __NULL__|0|1) ;;
  *) echo "unexpected previous maintenance value" >&2; exit 1 ;;
esac
printf '%s\n' "$PREVIOUS_VALUE" > "$BACKUP_DIR/maintenance-mode.before"
chmod 0600 "$BACKUP_DIR/maintenance-mode.before"
CONTAINER_DB_BACKUP="/app/server/data/.maintenance-backup-${STAMP}.db"
docker exec -i "$CONTAINER" node --input-type=module - "$CONTAINER_DB_BACKUP" <<'NODE'
import Database from 'better-sqlite3';
const target = process.argv[2];
const db = new Database('/app/server/data/freeapi.db', { readonly: true, fileMustExist: true });
await db.backup(target);
db.close();
const copy = new Database(target, { readonly: true, fileMustExist: true });
if (copy.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('backup quick_check failed');
copy.close();
NODE
docker cp "$CONTAINER:$CONTAINER_DB_BACKUP" "$BACKUP_DIR/freeapi-before.db"
docker exec "$CONTAINER" rm -f -- "$CONTAINER_DB_BACKUP"
test -s "$BACKUP_DIR/freeapi-before.db"
sha256sum "$BACKUP_DIR/freeapi-before.db" "$BACKUP_DIR/index.html.before" > "$BACKUP_DIR/SHA256SUMS"

rollback() {
  local code="${1:-$?}"
  trap - ERR HUP INT TERM
  set +e
  previous="$(head -n 1 "$BACKUP_DIR/maintenance-mode.before" 2>/dev/null)"
  docker cp "$BACKUP_DIR/index.html.before" "$CONTAINER:$INDEX_PATH" >/dev/null 2>&1
  docker exec -i "$CONTAINER" node --input-type=module - "$previous" <<'NODE' >/dev/null 2>&1
import Database from 'better-sqlite3';
const previous = process.argv[2];
const db = new Database('/app/server/data/freeapi.db', { fileMustExist: true });
if (previous === '__NULL__') db.prepare("DELETE FROM settings WHERE key='maintenance_mode'").run();
else db.prepare("INSERT INTO settings(key,value) VALUES('maintenance_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(previous);
db.close();
NODE
  echo maintenance_result=rolled_back >&2
  exit "$code"
}
trap 'rollback $?' ERR
trap 'rollback 129' HUP
trap 'rollback 130' INT
trap 'rollback 143' TERM

stage=enable_api_maintenance
stage "$stage"
docker exec -i "$CONTAINER" node --input-type=module - <<'NODE'
import Database from 'better-sqlite3';
const db = new Database('/app/server/data/freeapi.db', { fileMustExist: true });
db.prepare("INSERT INTO settings(key,value) VALUES('maintenance_mode','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
const value = db.prepare("SELECT value FROM settings WHERE key='maintenance_mode'").get()?.value;
db.close();
if (value !== '1') throw new Error('maintenance setting was not persisted');
NODE

stage=install_maintenance_page
stage "$stage"
docker exec -i "$CONTAINER" node --input-type=module - "$INDEX_PATH" "$MARKER" <<'NODE'
import fs from 'node:fs';
const [path, marker] = process.argv.slice(2);
let html = fs.readFileSync(path, 'utf8');
if (!html.includes(marker)) {
  const payload = `
<!-- ${marker} -->
<script>
(() => {
  if (location.pathname === '/admin' || location.pathname.startsWith('/admin/')) return;
  const show = () => {
    if (document.getElementById('tuoke-maintenance-overlay')) return;
    const overlay = document.createElement('main');
    overlay.id = 'tuoke-maintenance-overlay';
    overlay.setAttribute('role', 'status');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#0b0f14;color:#edf3f8;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px';
    overlay.innerHTML = '<section style="width:min(520px,100%);text-align:center;border:1px solid #27313c;border-radius:20px;background:#111820;padding:44px 28px;box-shadow:0 24px 80px #0008"><div style="margin:auto;width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:#172434;color:#67a7ff;font-size:24px">&#9679;</div><h1 style="margin:22px 0 10px;font-size:28px">\u7cfb\u7edf\u7ef4\u62a4\u4e2d</h1><p style="margin:0;color:#9eabb8;line-height:1.8">\u7f51\u7ad9\u6b63\u5728\u8fdb\u884c\u4e34\u65f6\u7ef4\u62a4\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002</p></section>';
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
  else show();
})();
</script>`;
  if (!html.includes('</body>')) throw new Error('client index has no closing body tag');
  html = html.replace('</body>', `${payload}\n</body>`);
  fs.writeFileSync(path, html);
}
NODE

stage=verify
stage "$stage"
docker exec "$CONTAINER" grep -Fq "$MARKER" "$INDEX_PATH"
docker exec -i "$CONTAINER" node --input-type=module - <<'NODE'
import Database from 'better-sqlite3';
const db = new Database('/app/server/data/freeapi.db', { readonly: true, fileMustExist: true });
if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('live quick_check failed');
if (db.prepare("SELECT value FROM settings WHERE key='maintenance_mode'").get()?.value !== '1') throw new Error('maintenance mode is not enabled');
db.close();
NODE

settings="$(curl --fail --silent --show-error --retry 5 --retry-all-errors 'https://tuokeapi.com/api/public/settings')"
grep -Eq '"maintenance_mode"[[:space:]]*:[[:space:]]*true' <<<"$settings"
homepage="$(curl --fail --silent --show-error --retry 5 --retry-all-errors "https://tuokeapi.com/?maintenance=${STAMP}")"
grep -Fq "$MARKER" <<<"$homepage"
status="$(curl --silent --output "$BACKUP_DIR/v1-maintenance-response.txt" --write-out '%{http_code}' -X POST 'https://tuokeapi.com/v1/responses' -H 'content-type: application/json' --data '{"model":"test","input":"test"}')"
test "$status" = 503
grep -Fq 'maintenance_mode' "$BACKUP_DIR/v1-maintenance-response.txt"

trap - ERR HUP INT TERM
echo maintenance_result=enabled
echo "backup_dir=$BACKUP_DIR"
echo public_maintenance_page=ok
echo api_maintenance_503=ok
