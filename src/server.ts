import { McpServer } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { registerShellTools } from './tools/shell.js';
import { registerFileTools } from './tools/files.js';
import { registerDockerTools } from './tools/docker.js';
import { registerSystemTools } from './tools/system.js';

/**
 * Build a fresh McpServer. The SDK calls this per request, so it must stay cheap
 * and must not hold per-connection state.
 */
export function buildServer(cfg: Config): McpServer {
    const server = new McpServer(
        { name: 'server-remote-control', version: '1.0.0' },
        {
            instructions:
                `These tools operate on the remote host "${cfg.serverLabel}" over an authenticated HTTPS channel. ` +
                `Commands run as root. ` +
                (cfg.readonly
                    ? `This server is in READ-ONLY mode: tools that modify the host will be refused. `
                    : `Changes take effect immediately on a live machine, so read before you write, prefer ` +
                      `edit_file over write_file for existing configs, and confirm destructive actions with the user. `) +
                `File paths are host paths (e.g. /etc/nginx/nginx.conf), not container paths. ` +
                `Start with system_overview for health questions, docker_ps for container questions, and ` +
                `service_status with no unit to find what is failing.`,
        },
    );

    if (cfg.toolsets.includes('shell')) registerShellTools(server, cfg);
    if (cfg.toolsets.includes('files')) registerFileTools(server, cfg);
    if (cfg.toolsets.includes('docker')) registerDockerTools(server, cfg);
    if (cfg.toolsets.includes('system')) registerSystemTools(server, cfg);

    return server;
}
