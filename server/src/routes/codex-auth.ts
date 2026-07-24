import { Router } from 'express';

import { requireAdmin } from '../middleware/requireAdmin.js';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getCodexDeviceAuthorization,
  startCodexDeviceAuthorization,
} from '../services/codex-device-auth.js';

export const codexAuthRouter = Router();

codexAuthRouter.post('/device/start', requireAuth, requireAdmin, async (_req, res) => {
  try {
    res.json(await startCodexDeviceAuthorization());
  } catch (error) {
    res.status(502).json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to start Codex authorization',
        type: 'upstream_error',
      },
    });
  }
});

codexAuthRouter.get('/device/status/:loginId', requireAuth, requireAdmin, (req, res) => {
  const loginId = Array.isArray(req.params.loginId) ? req.params.loginId[0] : req.params.loginId;
  const result = getCodexDeviceAuthorization(loginId);
  if (!result) {
    res.status(404).json({
      error: { message: 'Codex authorization session not found', type: 'not_found' },
    });
    return;
  }
  res.json(result);
});
