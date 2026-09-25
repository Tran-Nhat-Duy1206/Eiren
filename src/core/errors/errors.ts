import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger/logger.js';

export class AppError extends Error {
  constructor(public readonly code: 'VALIDATION' | 'PERMISSION' | 'NOT_FOUND' | 'CONFLICT' | 'DISABLED' | 'DATABASE', message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export function handleError(error: unknown, logger: Logger, context: Record<string, unknown>): string {
  if (error instanceof AppError && error.code !== 'DATABASE') {
    logger.warn({ ...context, code: error.code }, 'Request rejected');
    return error.message;
  }
  const errorId = randomUUID();
  // Do not log request payloads or connection strings: driver exceptions can contain credentials.
  // Retain the complete stack for non-driver errors; database failures use a sanitized category.
  if (error instanceof AppError && error.code === 'DATABASE') {
    logger.error({ ...context, errorId, errorCode: error.code }, 'Database request failed');
  } else {
    logger.error({ ...context, errorId, err: error }, 'Unexpected error');
  }
  return `Something went wrong. Error ID: ${errorId}`;
}
