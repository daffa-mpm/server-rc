import { spawn } from 'node:child_process';
import type { Config } from './config.js';
import { findBlockedPattern } from './guard.js';
import { normalizeHostPath, toContainerPath } from './paths.js';

export class ExecDenied extends Error {}

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    truncated: boolean;
    durationMs: number;
}

export interface ExecOptions {
    command: string;
    cwd?: string | undefined;
    timeoutSec?: number | undefined;
    stdin?: string | undefined;
    env?: Record<string, string> | undefined;
    /** Skip the catastrophic-command guard. Used by tools that build their own argv. */
    trusted?: boolean;
    /**
     * Force execution inside this container instead of honouring RC_EXEC_MODE.
     * Used by the Docker tools, which talk to the mounted daemon socket with the
     * container's own CLI and so must not depend on the host having one.
     */
    local?: boolean;
}

/** POSIX single-quote escaping: wrap in '...' and escape embedded quotes. */
export function shq(s: string): string {
    return `'` + s.replace(/'/g, `'\''`) + `'`;
}

function clamp(cfg: Config, text: string): { text: string; truncated: boolean } {
    const buf = Buffer.from(text, 'utf8');
    if (buf.byteLength <= cfg.maxOutputBytes) return { text, truncated: false };
    const head = buf.subarray(0, Math.floor(cfg.maxOutputBytes * 0.7)).toString('utf8');
    const tail = buf.subarray(buf.byteLength - Math.floor(cfg.maxOutputBytes * 0.25)).toString('utf8');
    const omitted = buf.byteLength - cfg.maxOutputBytes;
    return {
        text: `${head}\n\n... [${omitted} bytes omitted -- rerun with a narrower command, grep, or head/tail] ...\n\n${tail}`,
        truncated: true,
    };
}

/**
 * Run a command. In `nsenter` mode it executes in the host's namespaces (real host
 * shell, host PATH, host processes); in `container` mode it stays inside this
 * container with the host filesystem visible under RC_HOST_ROOT.
 */
export function runHost(cfg: Config, opts: ExecOptions): Promise<ExecResult> {
    const { command } = opts;
    if (!command || !command.trim()) throw new ExecDenied('command must not be empty');

    if (!opts.trusted) {
        const hit = findBlockedPattern(command, cfg.blockedPatterns);
        if (hit) {
            throw new ExecDenied(
                `Command refused by the catastrophic-command guard (matched /${hit}/). ` +
                `If this is intentional, run it yourself on the host, or adjust ` +
                `RC_BLOCKED_COMMAND_PATTERNS / RC_DISABLE_COMMAND_GUARD.`,
            );
        }
    }

    const timeoutSec = Math.min(opts.timeoutSec ?? cfg.defaultTimeoutSec, cfg.maxTimeoutSec);
    const mode = opts.local ? 'container' : cfg.execMode;

    // Prepend the cd so it applies inside the target namespace/filesystem.
    let script = command;
    if (opts.cwd) {
        const hostCwd = normalizeHostPath(opts.cwd);
        const target = mode === 'nsenter' ? hostCwd : toContainerPath(cfg, hostCwd);
        script = `cd ${shq(target)} || exit 1\n${command}`;
    }

    const argv: string[] =
        mode === 'nsenter'
            ? ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', cfg.shell, '-lc', script]
            : ['-lc', script];
    const bin = mode === 'nsenter' ? 'nsenter' : cfg.shell;

    return new Promise<ExecResult>((resolve, reject) => {
        const started = Date.now();
        const child = spawn(bin, argv, {
            env: { ...process.env, ...(opts.env ?? {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;

        const limit = cfg.maxOutputBytes * 4; // hard stop so a runaway stream cannot exhaust memory
        child.stdout.on('data', (d: Buffer) => {
            if (stdout.length < limit) stdout += d.toString('utf8');
        });
        child.stderr.on('data', (d: Buffer) => {
            if (stderr.length < limit) stderr += d.toString('utf8');
        });

        const killTimer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 5000).unref();
        }, timeoutSec * 1000);

        child.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            reject(new Error(
                `Failed to launch ${bin}: ${err.message}` +
                (mode === 'nsenter'
                    ? ` -- nsenter mode needs the container to run with --pid=host and --privileged (or CAP_SYS_ADMIN).`
                    : ''),
            ));
        });

        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            const o = clamp(cfg, stdout);
            const e = clamp(cfg, stderr);
            resolve({
                stdout: o.text,
                stderr: e.text,
                exitCode: code,
                signal: signal ?? null,
                timedOut,
                truncated: o.truncated || e.truncated,
                durationMs: Date.now() - started,
            });
        });

        if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
        child.stdin.end();
    });
}

/** Convenience wrapper for internal, argv-built commands (systemctl, journalctl, ...). */
export async function runTrusted(cfg: Config, command: string, timeoutSec?: number): Promise<ExecResult> {
    return runHost(cfg, { command, trusted: true, ...(timeoutSec !== undefined ? { timeoutSec } : {}) });
}

/**
 * Run inside this container regardless of RC_EXEC_MODE. The Docker tools use this
 * so they work through the mounted daemon socket with the CLI shipped in this image,
 * rather than requiring the host to have a docker binary of its own.
 */
export async function runLocal(cfg: Config, command: string, timeoutSec?: number): Promise<ExecResult> {
    return runHost(cfg, { command, trusted: true, local: true, ...(timeoutSec !== undefined ? { timeoutSec } : {}) });
}
