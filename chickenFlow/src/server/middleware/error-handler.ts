import type { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: Error & { statusCode?: number },
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error('[API Error]', err.message, err.stack);
  const status = err.statusCode ?? 500;
  res.status(status).json({
    error: err.name ?? 'InternalServerError',
    message: err.message ?? 'An unexpected error occurred',
    statusCode: status,
  });
}
