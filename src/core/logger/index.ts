/**
 * core/logger/index.ts
 *
 * Structured JSON logger with requestId correlation.
 * Every log line carries: requestId, userId, route, durationMs.
 * Uses pino for performance — JSON to stdout, parsed by the platform.
 */
import pino from 'pino';
import { env } from '@/core/config/env';

export type Logger = pino.Logger;

/**
 * Create a child logger with a requestId for request correlation.
 */
export function createLogger(requestId: string): Logger {
  return baseLogger.child({ requestId });
}

/**
 * Create a child logger with additional context.
 */
export function childLogger(
  parent: Logger,
  context: Record<string, unknown>,
): Logger {
  return parent.child(context);
}

const baseLogger = pino({
  level: env.LOG_LEVEL,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export { baseLogger as logger };
