import fs from 'node:fs';
import type { Config } from './config.js';

export interface AuditEntry {
    ts: string;
    tool: string;
    args: unknown;
    ok: boolean;
    ms: number;
    error?: string;
    peer?: string;
}

let stream: fs.WriteStream | null = null;

export function initAudit(cfg: Config): void {
    if (!cfg.auditFile) return;
    stream = fs.createWriteStream(cfg.auditFile, { flags: 'a' });
    stream.on('error', err => console.error('[audit] write failed:', err.message));
}

/**
 * Every tool invocation is recorded. Arguments are logged verbatim -- treat the
 * audit log as sensitive, since command text and file contents pass through it.
 */
export function audit(entry: AuditEntry): void {
    const line = JSON.stringify(entry);
    console.log(line);
    stream?.write(line + '\n');
}
