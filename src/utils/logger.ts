import * as fs from 'fs';
import * as path from 'path';

// ─── File setup ─────────────────────────────────────────────────────────────

const LOG_DIR  = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB before rotation

// Ensure the directory exists (no-op if already present)
fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Rotation ────────────────────────────────────────────────────────────────

function rotateLogs(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const { size } = fs.statSync(LOG_FILE);
    if (size < MAX_BYTES) return;
    // Rename current log → bot.log.1 (overwrite previous backup)
    fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'bot.log.1'));
  } catch {
    // Rotation failure is non-fatal — just continue writing
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const prefix    = `[${timestamp}] [${level}]`;
  const dataSuffix = data !== undefined ? ' ' + JSON.stringify(data) : '';
  const line       = `${prefix} ${message}${dataSuffix}`;

  // Console
  console.log(line);

  // File (rotate first if oversized, then append)
  try {
    rotateLogs();
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // File write failure must never crash the bot
  }
}
