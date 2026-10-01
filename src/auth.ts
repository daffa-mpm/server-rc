import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from './config.js';

/**
 * Compare two secrets without leaking their contents through timing. Both sides are
 * hashed first so timingSafeEqual always sees equal-length buffers, which it requires.
 */
function secretsMatch(a: string, b: string): boolean {
    const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
    const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
    return crypto.timingSafeEqual(ha, hb);
}

function presentedToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (typeof header === 'string') {
        const m = /^Bearer\s+(.+)$/i.exec(header.trim());
        if (m?.[1]) return m[1].trim();
    }
    const alt = req.headers['x-api-key'];
    if (typeof alt === 'string' && alt.trim()) return alt.trim();
    return null;
}

/**
 * Require the shared bearer token. This token is the only thing between the public
 * internet and root on the host, so failures are logged and never explain themselves
 * beyond "unauthorized".
 */
export function bearerAuth(cfg: Config) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const token = presentedToken(req);
        const peer = req.ip ?? 'unknown';

        if (token && secretsMatch(token, cfg.token)) {
            next();
            return;
        }

        console.warn(
            JSON.stringify({
                ts: new Date().toISOString(),
                event: 'auth_failed',
                peer,
                reason: token ? 'bad_token' : 'no_token',
                path: req.path,
            }),
        );
        res.status(401)
            .set('WWW-Authenticate', 'Bearer realm="server-remote-control"')
            .json({ error: 'unauthorized' });
    };
}
