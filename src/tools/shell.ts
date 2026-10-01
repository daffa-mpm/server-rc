import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { runHost } from '../exec.js';
import { defineTool, formatExec } from './common.js';

export function registerShellTools(server: McpServer, cfg: Config): void {
    defineTool(
        server,
        cfg,
        'run_command',
        {
            title: 'Run shell command',
            description:
                `Run a shell command on ${cfg.serverLabel} and return its stdout, stderr and exit code. ` +
                `Runs as root in the host namespaces. Commands are non-interactive and cannot prompt, so ` +
                `pass flags like -y. To start something long-running, launch it detached ` +
                `(nohup ... >/var/log/x.log 2>&1 &) instead of waiting on it here.`,
            mutating: true,
            inputSchema: z.object({
                command: z.string().describe('Shell command to run, e.g. "df -h" or "systemctl status nginx".'),
                cwd: z.string().optional().describe('Absolute host directory to run in. Defaults to /.'),
                timeout_sec: z.number().int().positive().optional()
                    .describe(`Seconds before the command is killed. Default ${cfg.defaultTimeoutSec}, max ${cfg.maxTimeoutSec}.`),
                stdin: z.string().optional().describe('Text piped to the command on stdin.'),
            }),
        },
        async args => {
            const command = String(args['command']);
            const r = await runHost(cfg, {
                command,
                cwd: args['cwd'] as string | undefined,
                timeoutSec: args['timeout_sec'] as number | undefined,
                stdin: args['stdin'] as string | undefined,
            });
            return formatExec(r, { label: command });
        },
    );
}
