import type { Request, Response, NextFunction } from 'express';
import type { z } from 'zod';

// Validates req.body against `schema`. On success, req.body is replaced with
// the parsed (and type-coerced/defaulted) result so downstream handlers can
// trust its shape without re-checking. On failure, 400s with the zod issues
// instead of calling next() — malformed input never reaches a route handler.
export function validate<T>(schema: z.ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'BadRequest',
        message: 'Invalid request body',
        statusCode: 400,
        issues: result.error.issues,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
