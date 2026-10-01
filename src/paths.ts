import path from 'node:path';
import fs from 'node:fs/promises';
import type { Config } from './config.js';

export class PathDenied extends Error {}

function isUnder(child: string, parent: string): boolean {
    if (parent === '/') return true;
    return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

/** Normalise a caller-supplied host path to an absolute, traversal-free POSIX path. */
export function normalizeHostPath(input: string): string {
    if (!input || typeof input !== 'string') throw new PathDenied('path must be a non-empty string');
    if (input.includes('\0')) throw new PathDenied('path must not contain null bytes');
    const abs = input.startsWith('/') ? input : '/' + input;
    const norm = path.posix.normalize(abs);
    return norm.length > 1 && norm.endsWith('/') ? norm.slice(0, -1) : norm;
}

function assertAllowed(cfg: Config, hostPath: string): void {
    if (!cfg.allowedPaths.some(a => isUnder(hostPath, normalizeHostPath(a)))) {
        throw new PathDenied(
            `Path ${hostPath} is outside the allowed roots (RC_ALLOWED_PATHS=${cfg.allowedPaths.join(':')})`,
        );
    }
    const denied = cfg.deniedPaths.find(d => isUnder(hostPath, normalizeHostPath(d)));
    if (denied) throw new PathDenied(`Path ${hostPath} is inside a denied root (${denied})`);
}

/** Map a host path into this container's view of the host filesystem. */
export function toContainerPath(cfg: Config, hostPath: string): string {
    return cfg.hostRoot === '/' ? hostPath : path.posix.join(cfg.hostRoot, hostPath);
}

/** Map a container path back to the host path it represents. */
export function toHostPath(cfg: Config, containerPath: string): string {
    if (cfg.hostRoot === '/') return containerPath;
    if (containerPath === cfg.hostRoot) return '/';
    if (containerPath.startsWith(cfg.hostRoot + '/')) return containerPath.slice(cfg.hostRoot.length);
    return containerPath;
}

export interface ResolvedPath {
    /** Path as the host sees it -- what the caller passed and what we echo back. */
    host: string;
    /** Path as this process must open it. */
    container: string;
}

/**
 * Which spelling of a resolved path a *shell command* must use.
 *
 * Node's own fs calls always use `.container` (this process sees the host under
 * RC_HOST_ROOT). Shell commands differ: in `nsenter` mode they execute in the host's
 * mount namespace, where RC_HOST_ROOT does not exist and the host path is correct.
 * Authorisation has already happened in resolvePath either way.
 */
export function pathForShell(cfg: Config, resolved: ResolvedPath): string {
    return cfg.execMode === 'nsenter' ? resolved.host : resolved.container;
}

/**
 * Resolve and authorise a host path. When the path exists, its realpath is
 * re-checked against the allowlist so a symlink cannot be used to escape it.
 */
export async function resolvePath(cfg: Config, input: string): Promise<ResolvedPath> {
    const host = normalizeHostPath(input);
    assertAllowed(cfg, host);
    const container = toContainerPath(cfg, host);

    let realContainer: string;
    try {
        realContainer = await fs.realpath(container);
    } catch {
        // Path does not exist yet (a create/write target). Validate the deepest
        // existing ancestor instead, so a symlinked parent cannot smuggle us out.
        let probe = path.posix.dirname(container);
        for (;;) {
            try {
                const realProbe = await fs.realpath(probe);
                assertAllowed(cfg, toHostPath(cfg, realProbe));
                return { host, container };
            } catch (err) {
                if (err instanceof PathDenied) throw err;
                const next = path.posix.dirname(probe);
                if (next === probe) return { host, container };
                probe = next;
            }
        }
    }
    assertAllowed(cfg, toHostPath(cfg, realContainer));
    return { host, container: realContainer };
}
