import type { Request, Response, NextFunction } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: { role?: string } }).user;
  if (user?.role !== 'admin') {
    res.status(403).json({ error: { message: 'Administrator access required', type: 'permission_error' } });
    return;
  }
  next();
}
