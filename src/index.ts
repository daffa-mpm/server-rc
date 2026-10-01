import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadConfig } from './config.js';
import { initAudit } from './audit.js';
import { bearerAuth } from './auth.js';
import { buildServer } from './server.js';

function main(): void {
    let cfg;
    try {
        cfg = loadConfig();
    } catch (err) {
        console.error(`[config] ${(err as Error).message}`);
        process.exit(1);
    }

    initAudit(cfg);

    const allowedHosts = (process.env['RC_ALLOWED_HOSTS'] ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const app = createMcpExpressApp({
        host: cfg.bind,
        ...(allowedHosts.length ? { allowedHosts } : {}),
    });

    // Trust the reverse proxy so req.ip reflects the real client in audit logs.
    if (cfg.trustProxy) app.set('trust proxy', true);

    // Unauthenticated: just enough for a proxy or compose healthcheck, no host details.
    app.get('/healthz', (_req, res) => {
        res.json({ status: 'ok', server: cfg.serverLabel });
    });

    const handler = createMcpHandler(() => buildServer(cfg));
    const node = toNodeHandler(handler);

    app.all(cfg.mcpPath, bearerAuth(cfg), (req, res) => {
        void node(req, res, req.body);
    });

    const server = app.listen(cfg.port, cfg.bind, () => {
        console.log(
            JSON.stringify({
                ts: new Date().toISOString(),
                event: 'listening',
                bind: `${cfg.bind}:${cfg.port}`,
                path: cfg.mcpPath,
                server: cfg.serverLabel,
                execMode: cfg.execMode,
                toolsets: cfg.toolsets,
                readonly: cfg.readonly,
                allowedPaths: cfg.allowedPaths,
                allowDelete: cfg.allowDelete,
            }),
        );
    });

    const shutdown = (signal: string) => () => {
        console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'shutdown', signal }));
        server.close(() => process.exit(0));
        // Do not let a hung in-flight command block the restart forever.
        setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.on('SIGTERM', shutdown('SIGTERM'));
    process.on('SIGINT', shutdown('SIGINT'));
}

main();
