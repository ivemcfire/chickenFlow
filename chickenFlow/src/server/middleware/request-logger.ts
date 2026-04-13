import type { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[API] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
}
