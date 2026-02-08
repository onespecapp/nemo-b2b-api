import { Request, Response, NextFunction } from 'express';
import { log } from '../config';

export const asyncHandler = (fn: Function) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Global error handler — must be registered AFTER routes
export function globalErrorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  // Don't log full error details to avoid leaking sensitive info
  log.error('Unhandled error', { message: err.message, name: err.name });

  // Handle CORS errors specifically
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  res.status(500).json({ error: 'Internal server error' });
}
