import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { listResourceAlerts, raiseResourceAlert, resolveResourceAlert } from '../../services/resource-alerts.js';

describe('resource operational alerts', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });
  beforeEach(() => getDb().prepare('DELETE FROM resource_operational_alerts').run());

  it('deduplicates an open source alert and tracks occurrences', () => {
    const db = getDb();
    const first = raiseResourceAlert(db, { severity: 'critical', alertType: 'oauth_invalid', sourceType: 'codex_account', sourceId: 9, message: 'invalid' });
    const second = raiseResourceAlert(db, { severity: 'critical', alertType: 'oauth_invalid', sourceType: 'codex_account', sourceId: 9, message: 'still invalid' });
    expect(second).toBe(first);
    expect(listResourceAlerts(db)).toMatchObject([{ id: first, occurrenceCount: 2, message: 'still invalid' }]);
  });

  it('resolves an alert idempotently', () => {
    const db = getDb();
    const adminId = Number(db.prepare(`INSERT INTO users (email, password_hash, role) VALUES ('alert-admin@example.com', 'x', 'admin')`).run().lastInsertRowid);
    const id = raiseResourceAlert(db, { severity: 'warning', alertType: 'maintenance_failed', sourceType: 'resource_maintenance', sourceId: 'periodic', message: 'failed' });
    expect(resolveResourceAlert(db, id, adminId)).toBe(true);
    expect(resolveResourceAlert(db, id, adminId)).toBe(false);
    expect(listResourceAlerts(db)).toEqual([]);
    expect(listResourceAlerts(db, 'resolved')).toHaveLength(1);
  });
});
