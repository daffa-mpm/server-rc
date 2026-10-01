import os from 'node:os';
import { DEFAULT_BLOCKED_PATTERNS, compilePatterns } from './guard.js';

function str(name: string, fallback?: string): string {
    const v = process.env[name];
    if (v === undefined || v === '') {
        if (fallback === undefined) throw new Error(`Missing required env var ${name}`);
        return fallback;
    }
    return v;
}

function bool(name: string, fallback: boolean): boolean {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function int(name: string, fallback: number): number {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got ${JSON.stringify(v)}`);
    return n;
}

/** Split on ":" or "," and drop empties. Used for path and toolset lists. */
function list(name: string, fallback: string): string[] {
    return str(name, fallback)
        .split(/[:,]/)
        .map(s => s.trim())
        .filter(Boolean);
}

export const TOOLSETS = ['shell', 'files', 'docker', 'system'] as const;
export type Toolset = (typeof TOOLSETS)[number];

export interface Config {
    token: string;
    port: number;
    bind: string;
    mcpPath: string;
    serverLabel: string;
    /** Where the host filesystem is mounted inside this container. */
    hostRoot: string;
    /** `nsenter` runs commands in the host's namespaces; `container` keeps them inside. */
    execMode: 'nsenter' | 'container';
    shell: string;
    readonly: boolean;
    toolsets: Toolset[];
    allowedPaths: string[];
    deniedPaths: string[];
    maxOutputBytes: number;
    defaultTimeoutSec: number;
    maxTimeoutSec: number;
    allowDelete: boolean;
    allowServiceControl: boolean;
    blockedPatterns: RegExp[];
    auditFile: string | null;
    trustProxy: boolean;
}

export function loadConfig(): Config {
    const token = str('RC_TOKEN');
    if (token.length < 32) {
        throw new Error(
            `RC_TOKEN must be at least 32 characters (got ${token.length}). ` +
            `Generate one with: openssl rand -hex 32`,
        );
    }

    const execMode = str('RC_EXEC_MODE', 'nsenter');
    if (execMode !== 'nsenter' && execMode !== 'container') {
        throw new Error(`RC_EXEC_MODE must be "nsenter" or "container", got ${JSON.stringify(execMode)}`);
    }

    const toolsets = list('RC_TOOLSETS', TOOLSETS.join(','));
    for (const t of toolsets) {
        if (!(TOOLSETS as readonly string[]).includes(t)) {
            throw new Error(`Unknown toolset ${JSON.stringify(t)}. Valid: ${TOOLSETS.join(', ')}`);
        }
    }

    const guardDisabled = bool('RC_DISABLE_COMMAND_GUARD', false);
    const extraPatterns = (process.env['RC_BLOCKED_COMMAND_PATTERNS'] ?? '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
    const patternSources = guardDisabled ? extraPatterns : [...DEFAULT_BLOCKED_PATTERNS, ...extraPatterns];

    const defaultTimeoutSec = int('RC_DEFAULT_TIMEOUT_SEC', 60);
    const maxTimeoutSec = int('RC_MAX_TIMEOUT_SEC', 900);
    if (defaultTimeoutSec > maxTimeoutSec) {
        throw new Error(`RC_DEFAULT_TIMEOUT_SEC (${defaultTimeoutSec}) exceeds RC_MAX_TIMEOUT_SEC (${maxTimeoutSec})`);
    }

    return {
        token,
        port: int('RC_PORT', 8723),
        bind: str('RC_BIND', '0.0.0.0'),
        mcpPath: str('RC_MCP_PATH', '/mcp'),
        serverLabel: str('RC_SERVER_LABEL', os.hostname()),
        hostRoot: str('RC_HOST_ROOT', '/host').replace(/\/+$/, '') || '/',
        execMode,
        shell: str('RC_SHELL', '/bin/bash'),
        readonly: bool('RC_READONLY', false),
        toolsets: toolsets as Toolset[],
        allowedPaths: list('RC_ALLOWED_PATHS', '/'),
        deniedPaths: list('RC_DENIED_PATHS', ''),
        maxOutputBytes: int('RC_MAX_OUTPUT_BYTES', 100_000),
        defaultTimeoutSec,
        maxTimeoutSec,
        allowDelete: bool('RC_ALLOW_DELETE', false),
        allowServiceControl: bool('RC_ALLOW_SERVICE_CONTROL', true),
        blockedPatterns: compilePatterns(patternSources),
        auditFile: process.env['RC_AUDIT_FILE'] || null,
        trustProxy: bool('RC_TRUST_PROXY', true),
    };
}
