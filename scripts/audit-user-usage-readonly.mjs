import Database from 'better-sqlite3';

const DB_PATH = '/audit/freeapi.db';
const TARGET_EMAIL = '1030696088@qq.com';

const db = new Database(DB_PATH, {
  readonly: true,
  fileMustExist: true,
});

function emit(name, value) {
  process.stdout.write(`${name}=${JSON.stringify(value)}\n`);
}

function integer(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`unsafe integer in audit output: ${String(value)}`);
  }
  return number;
}

function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'number' || typeof value === 'bigint'
        ? integer(value)
        : value,
    ]),
  );
}

try {
  db.pragma('query_only = ON');
  if (integer(db.pragma('query_only', { simple: true })) !== 1) {
    throw new Error('SQLite query_only guard is not active');
  }
  const quickCheck = db.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') throw new Error(`quick_check failed: ${quickCheck}`);

  const requiredColumns = new Set(
    db.prepare('PRAGMA table_info(requests)').all().map((row) => row.name),
  );
  for (const column of [
    'input_tokens',
    'output_tokens',
    'input_compute_points',
    'output_compute_points',
    'compute_points_per_million_tokens',
    'consumer_user_id',
    'consumer_api_key_id',
    'user_visible',
  ]) {
    if (!requiredColumns.has(column)) {
      throw new Error(`required requests column is missing: ${column}`);
    }
  }

  const ordinaryUsers = normalizeRow(db.prepare(`
    SELECT
      COUNT(*) AS all_rows,
      SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS non_deleted_rows,
      SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted_rows
    FROM users
    WHERE role <> 'admin'
  `).get());

  const currentRates = normalizeRow(db.prepare(`
    WITH configured AS (
      SELECT CAST(value AS INTEGER) AS global_rate
      FROM settings
      WHERE key = 'compute_points_per_million_tokens'
      LIMIT 1
    ), target_user AS (
      SELECT compute_points_per_million_tokens AS user_override
      FROM users
      WHERE LOWER(email) = LOWER(?)
      LIMIT 1
    )
    SELECT
      CASE
        WHEN configured.global_rate BETWEEN 1000000 AND 1000000000
          THEN configured.global_rate
        ELSE 1000000
      END AS global_rate,
      target_user.user_override AS user_override,
      CASE
        WHEN target_user.user_override BETWEEN 1000000 AND 1000000000
          THEN target_user.user_override
        WHEN configured.global_rate BETWEEN 1000000 AND 1000000000
          THEN configured.global_rate
        ELSE 1000000
      END AS effective_rate
    FROM (SELECT 1) singleton
    LEFT JOIN configured ON 1 = 1
    LEFT JOIN target_user ON 1 = 1
  `).get(TARGET_EMAIL));

  const ownershipConflicts = normalizeRow(db.prepare(`
    SELECT
      COUNT(*) AS conflict_rows,
      COUNT(DISTINCT r.consumer_user_id) AS direct_users,
      COUNT(DISTINCT owner_key.user_id) AS key_owner_users
    FROM requests r
    JOIN consumer_api_keys owner_key
      ON owner_key.id = r.consumer_api_key_id
    WHERE r.consumer_user_id IS NOT NULL
      AND owner_key.user_id IS NOT NULL
      AND r.consumer_user_id <> owner_key.user_id
  `).get());

  const aggregate = normalizeRow(db.prepare(`
    WITH ordinary AS (
      SELECT
        u.id AS owner_user_id,
        r.user_visible,
        r.input_tokens,
        r.output_tokens,
        r.input_compute_points,
        r.output_compute_points,
        r.compute_points_per_million_tokens
      FROM requests r
      LEFT JOIN consumer_api_keys owner_key
        ON owner_key.id = r.consumer_api_key_id
      JOIN users u ON (
        r.consumer_user_id = u.id
        OR (r.consumer_user_id IS NULL AND owner_key.user_id = u.id)
      )
      WHERE u.role <> 'admin' AND u.deleted_at IS NULL
    )
    SELECT
      COUNT(*) AS request_rows,
      COUNT(DISTINCT owner_user_id) AS users_with_requests,
      SUM(CASE WHEN COALESCE(user_visible, 0) = 1 THEN 1 ELSE 0 END) AS visible_rows,
      SUM(CASE WHEN COALESCE(user_visible, 0) <> 1 THEN 1 ELSE 0 END) AS hidden_rows,
      SUM(CASE WHEN COALESCE(compute_points_per_million_tokens, 0) > 0 THEN 1 ELSE 0 END) AS snapshot_rows,
      SUM(CASE WHEN COALESCE(compute_points_per_million_tokens, 0) <= 0 THEN 1 ELSE 0 END) AS missing_snapshot_rows,
      SUM(CASE WHEN
        COALESCE(input_compute_points, 0) <> COALESCE(input_tokens, 0)
        OR COALESCE(output_compute_points, 0) <> COALESCE(output_tokens, 0)
      THEN 1 ELSE 0 END) AS divergent_rows,
      SUM(CASE WHEN COALESCE(compute_points_per_million_tokens, 0) > 0 AND (
        COALESCE(input_compute_points, 0) <> ROUND(COALESCE(input_tokens, 0) * compute_points_per_million_tokens / 1000000.0)
        OR COALESCE(output_compute_points, 0) <> ROUND(COALESCE(output_tokens, 0) * compute_points_per_million_tokens / 1000000.0)
      ) THEN 1 ELSE 0 END) AS snapshot_mismatch_rows,
      SUM(COALESCE(input_tokens, 0)) AS raw_input,
      SUM(COALESCE(output_tokens, 0)) AS raw_output,
      SUM(COALESCE(input_compute_points, 0)) AS points_input,
      SUM(COALESCE(output_compute_points, 0)) AS points_output
    FROM ordinary
  `).get());

  const snapshotIntegrity = normalizeRow(db.prepare(`
    WITH ordinary AS (
      SELECT u.id AS owner_user_id, r.*
      FROM requests r
      LEFT JOIN consumer_api_keys owner_key
        ON owner_key.id = r.consumer_api_key_id
      JOIN users u ON (
        r.consumer_user_id = u.id
        OR (r.consumer_user_id IS NULL AND owner_key.user_id = u.id)
      )
      WHERE u.role <> 'admin' AND u.deleted_at IS NULL
    ), mismatches AS (
      SELECT owner_user_id
      FROM ordinary
      WHERE COALESCE(compute_points_per_million_tokens, 0) > 0
        AND (
          COALESCE(input_compute_points, 0) <> ROUND(COALESCE(input_tokens, 0) * compute_points_per_million_tokens / 1000000.0)
          OR COALESCE(output_compute_points, 0) <> ROUND(COALESCE(output_tokens, 0) * compute_points_per_million_tokens / 1000000.0)
        )
    )
    SELECT
      COUNT(*) AS mismatch_rows,
      COUNT(DISTINCT owner_user_id) AS mismatch_users
    FROM mismatches
  `).get());

  const userCoverage = normalizeRow(db.prepare(`
    WITH owned AS (
      SELECT
        u.id AS owner_user_id,
        r.input_tokens,
        r.output_tokens,
        r.input_compute_points,
        r.output_compute_points,
        r.compute_points_per_million_tokens
      FROM requests r
      LEFT JOIN consumer_api_keys owner_key
        ON owner_key.id = r.consumer_api_key_id
      JOIN users u ON (
        r.consumer_user_id = u.id
        OR (r.consumer_user_id IS NULL AND owner_key.user_id = u.id)
      )
      WHERE u.role <> 'admin' AND u.deleted_at IS NULL
    ), per_user AS (
      SELECT
        owned.owner_user_id,
        SUM(CASE WHEN COALESCE(compute_points_per_million_tokens, 0) <= 0 THEN 1 ELSE 0 END) AS missing_rows,
        SUM(CASE WHEN
          COALESCE(input_compute_points, 0) <> COALESCE(input_tokens, 0)
          OR COALESCE(output_compute_points, 0) <> COALESCE(output_tokens, 0)
        THEN 1 ELSE 0 END) AS divergent_rows
      FROM owned
      GROUP BY owned.owner_user_id
    )
    SELECT
      COUNT(*) AS users_with_requests,
      SUM(CASE WHEN missing_rows > 0 THEN 1 ELSE 0 END) AS users_with_missing_snapshot,
      SUM(CASE WHEN divergent_rows > 0 THEN 1 ELSE 0 END) AS users_with_divergent_usage,
      SUM(CASE WHEN divergent_rows = 0 THEN 1 ELSE 0 END) AS users_with_equal_raw_and_points
    FROM per_user
  `).get());

  const perUserRates = normalizeRow(db.prepare(`
    WITH owned AS (
      SELECT
        u.id AS owner_user_id,
        COALESCE(r.compute_points_per_million_tokens, 0) AS rate
      FROM requests r
      LEFT JOIN consumer_api_keys owner_key
        ON owner_key.id = r.consumer_api_key_id
      JOIN users u ON (
        r.consumer_user_id = u.id
        OR (r.consumer_user_id IS NULL AND owner_key.user_id = u.id)
      )
      WHERE u.role <> 'admin' AND u.deleted_at IS NULL
    ), per_user AS (
      SELECT
        owner_user_id,
        COUNT(*) AS request_rows,
        COUNT(DISTINCT CASE WHEN rate > 0 THEN rate END) AS positive_rate_count,
        SUM(CASE WHEN rate <= 0 THEN 1 ELSE 0 END) AS missing_rate_rows,
        SUM(CASE WHEN rate = 1000000 THEN 1 ELSE 0 END) AS one_x_rows,
        SUM(CASE WHEN rate > 0 AND rate <> 1000000 THEN 1 ELSE 0 END) AS non_one_x_rows
      FROM owned
      GROUP BY owner_user_id
    )
    SELECT
      SUM(CASE WHEN positive_rate_count > 1 THEN 1 ELSE 0 END) AS mixed_rate_users,
      SUM(CASE WHEN request_rows > 0 AND missing_rate_rows = 0 AND one_x_rows = request_rows THEN 1 ELSE 0 END) AS only_1x_users,
      SUM(CASE WHEN non_one_x_rows > 0 THEN 1 ELSE 0 END) AS non_1x_users
    FROM per_user
  `).get());

  const rateSegments = db.prepare(`
    WITH owned AS (
      SELECT
        u.id AS owner_user_id,
        r.user_visible,
        r.input_tokens,
        r.output_tokens,
        r.input_compute_points,
        r.output_compute_points,
        r.compute_points_per_million_tokens
      FROM requests r
      LEFT JOIN consumer_api_keys owner_key
        ON owner_key.id = r.consumer_api_key_id
      JOIN users u ON (
        r.consumer_user_id = u.id
        OR (r.consumer_user_id IS NULL AND owner_key.user_id = u.id)
      )
      WHERE u.role <> 'admin' AND u.deleted_at IS NULL
    )
    SELECT
      COALESCE(compute_points_per_million_tokens, 0) AS rate,
      COALESCE(user_visible, 0) AS user_visible,
      COUNT(*) AS request_rows,
      COUNT(DISTINCT owner_user_id) AS users,
      SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS raw_total,
      SUM(COALESCE(input_compute_points, 0) + COALESCE(output_compute_points, 0)) AS points_total
    FROM owned
    GROUP BY rate, COALESCE(user_visible, 0)
    ORDER BY rate, user_visible
  `).all().map(normalizeRow);

  const target = db.prepare(`
    SELECT id, role, deleted_at
    FROM users
    WHERE LOWER(email) = LOWER(?)
    LIMIT 1
  `).get(TARGET_EMAIL);

  const targetSummary = target
    ? normalizeRow(db.prepare(`
        WITH owned AS (
          SELECT r.*
          FROM requests r
          LEFT JOIN consumer_api_keys owner_key
            ON owner_key.id = r.consumer_api_key_id
          WHERE r.consumer_user_id = ?
            OR (r.consumer_user_id IS NULL AND owner_key.user_id = ?)
        )
        SELECT
          COUNT(*) AS request_rows,
          SUM(CASE WHEN COALESCE(user_visible, 0) = 1 THEN 1 ELSE 0 END) AS visible_rows,
          SUM(CASE WHEN COALESCE(user_visible, 0) <> 1 THEN 1 ELSE 0 END) AS hidden_rows,
          SUM(CASE WHEN COALESCE(compute_points_per_million_tokens, 0) > 0 THEN 1 ELSE 0 END) AS snapshot_rows,
          SUM(CASE WHEN COALESCE(compute_points_per_million_tokens, 0) <= 0 THEN 1 ELSE 0 END) AS missing_snapshot_rows,
          SUM(COALESCE(input_tokens, 0)) AS raw_input,
          SUM(COALESCE(output_tokens, 0)) AS raw_output,
          SUM(COALESCE(input_compute_points, 0)) AS points_input,
          SUM(COALESCE(output_compute_points, 0)) AS points_output,
          SUM(CASE WHEN COALESCE(user_visible, 0) = 1 THEN COALESCE(input_tokens, 0) ELSE 0 END) AS visible_raw_input,
          SUM(CASE WHEN COALESCE(user_visible, 0) = 1 THEN COALESCE(output_tokens, 0) ELSE 0 END) AS visible_raw_output,
          SUM(CASE WHEN COALESCE(user_visible, 0) = 1 THEN COALESCE(input_compute_points, 0) ELSE 0 END) AS visible_points_input,
          SUM(CASE WHEN COALESCE(user_visible, 0) = 1 THEN COALESCE(output_compute_points, 0) ELSE 0 END) AS visible_points_output
        FROM owned
      `).get(target.id, target.id))
    : null;

  const targetSegments = target
    ? db.prepare(`
        WITH owned AS (
          SELECT r.*
          FROM requests r
          LEFT JOIN consumer_api_keys owner_key
            ON owner_key.id = r.consumer_api_key_id
          WHERE r.consumer_user_id = ?
            OR (r.consumer_user_id IS NULL AND owner_key.user_id = ?)
        )
        SELECT
          COALESCE(compute_points_per_million_tokens, 0) AS rate,
          COALESCE(user_visible, 0) AS user_visible,
          status,
          COUNT(*) AS request_rows,
          SUM(COALESCE(input_tokens, 0)) AS raw_input,
          SUM(COALESCE(output_tokens, 0)) AS raw_output,
          SUM(COALESCE(input_compute_points, 0)) AS points_input,
          SUM(COALESCE(output_compute_points, 0)) AS points_output
        FROM owned
        GROUP BY rate, COALESCE(user_visible, 0), status
        ORDER BY rate, user_visible, status
      `).all(target.id, target.id).map(normalizeRow)
    : [];

  const targetRecent20 = target
    ? db.prepare(`
        WITH recent AS (
          SELECT
            COALESCE(r.compute_points_per_million_tokens, 0) AS rate,
            COALESCE(r.user_visible, 0) AS user_visible,
            r.status,
            r.created_at
          FROM requests r
          LEFT JOIN consumer_api_keys owner_key
            ON owner_key.id = r.consumer_api_key_id
          WHERE r.consumer_user_id = ?
            OR (r.consumer_user_id IS NULL AND owner_key.user_id = ?)
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 20
        )
        SELECT
          rate,
          user_visible,
          status,
          COUNT(*) AS request_rows,
          MIN(created_at) AS min_created_at,
          MAX(created_at) AS max_created_at
        FROM recent
        GROUP BY rate, user_visible, status
        ORDER BY max_created_at DESC, rate, user_visible, status
      `).all(target.id, target.id).map(normalizeRow)
    : [];

  emit('audit_guard', {
    sqlite_readonly: true,
    sqlite_query_only: true,
    quick_check: quickCheck,
  });
  emit('ordinary_users', ordinaryUsers);
  emit('ownership_conflicts', ownershipConflicts);
  emit('ordinary_usage_aggregate', aggregate);
  emit('ordinary_snapshot_integrity', snapshotIntegrity);
  emit('ordinary_user_coverage', userCoverage);
  emit('ordinary_user_rate_coverage', perUserRates);
  emit('ordinary_rate_visibility_segments', rateSegments);
  emit('target', {
    found: Boolean(target),
    role: target?.role ?? null,
    deleted: target ? target.deleted_at !== null : null,
    current_rates: currentRates,
    summary: targetSummary,
    rate_visibility_segments: targetSegments,
    recent_20_aggregate: targetRecent20,
  });
} finally {
  db.close();
}
