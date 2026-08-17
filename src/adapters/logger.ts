import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatIso, ictToday } from '../core/ict.js';

const LOG_DIR = join(process.cwd(), 'logs');

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string, context?: unknown): void {
  const line = `${new Date().toISOString()} ${level} ${message}${context !== undefined ? ` ${JSON.stringify(context)}` : ''}`;
  const stream = level === 'ERROR' ? console.error : console.log;
  stream(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${formatIso(ictToday())}.log`), `${line}\n`);
  } catch {
    // File logging is best-effort: never let a log-write failure (e.g. an
    // unwritable logs/ dir) crash a dry-run or a live booking race. The line
    // was already printed to the console above.
  }
}

export const log = {
  info: (message: string, context?: unknown): void => write('INFO', message, context),
  warn: (message: string, context?: unknown): void => write('WARN', message, context),
  error: (message: string, context?: unknown): void => write('ERROR', message, context),
};
