import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { runTrusted, shq } from '../exec.js';
import { resolvePath, pathForShell } from '../paths.js';
import { defineTool, formatExec, text } from './common.js';

const SERVICE_ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable'] as const;

export function registerSystemTools(server: McpServer, cfg: Config): void {
    defineTool(
        server,
        cfg,
        'system_overview',
        {
            title: 'System overview',
            description:
                `One-shot health snapshot of ${cfg.serverLabel}: OS, uptime, load, CPU count, memory, disk usage ` +
                `and the top processes by memory and CPU. Start here when asked how the server is doing.`,
            inputSchema: z.object({}),
        },
        async () => {
            const script = [
                'echo "=== OS ==="; (cat /etc/os-release 2>/dev/null | head -3); uname -sr',
                'echo; echo "=== UPTIME / LOAD ==="; uptime',
                'echo; echo "=== CPU ==="; nproc 2>/dev/null | sed "s/^/cores: /"',
                'echo; echo "=== MEMORY ==="; free -h 2>/dev/null',
                'echo; echo "=== DISK ==="; df -hP -x tmpfs -x devtmpfs 2>/dev/null || df -h',
                'echo; echo "=== TOP 10 BY MEM ==="; ps -eo pid,user,pmem,pcpu,comm --sort=-pmem 2>/dev/null | head -11',
                'echo; echo "=== TOP 10 BY CPU ==="; ps -eo pid,user,pmem,pcpu,comm --sort=-pcpu 2>/dev/null | head -11',
            ].join('\n');
            const r = await runTrusted(cfg, script, 60);
            return text(r.stdout.trimEnd() || r.stderr.trimEnd() || '(no output)');
        },
    );

    defineTool(
        server,
        cfg,
        'service_status',
        {
            title: 'Service status',
            description:
                'Show systemd unit status. Omit "unit" to list failed units, which is the fast way to find what is broken.',
            inputSchema: z.object({
                unit: z.string().optional()
                    .describe('Unit name, e.g. "nginx" or "docker.service". Omit to list failed units.'),
            }),
        },
        async args => {
            const unit = args['unit'] as string | undefined;
            const cmd = unit
                ? `systemctl status ${shq(unit)} --no-pager --lines=20`
                : 'systemctl list-units --state=failed --no-pager; echo; systemctl is-system-running';
            const r = await runTrusted(cfg, cmd, 30);
            // systemctl status exits non-zero for a stopped unit; that is information, not failure.
            return text(`$ ${cmd}\n${r.stdout.trimEnd() || r.stderr.trimEnd() || '(no output)'}`);
        },
    );

    defineTool(
        server,
        cfg,
        'service_control',
        {
            title: 'Control service',
            description: 'Start, stop, restart, reload, enable or disable a systemd unit, then report its new status.',
            mutating: true,
            inputSchema: z.object({
                unit: z.string().describe('Unit name, e.g. "nginx".'),
                action: z.enum(SERVICE_ACTIONS).describe('What to do to the unit.'),
            }),
        },
        async args => {
            if (!cfg.allowServiceControl) {
                throw new Error('Service control is disabled on this server (RC_ALLOW_SERVICE_CONTROL=false).');
            }
            const unit = String(args['unit']);
            const action = String(args['action']);
            if (!(SERVICE_ACTIONS as readonly string[]).includes(action)) {
                throw new Error(`action must be one of: ${SERVICE_ACTIONS.join(', ')}`);
            }
            const cmd = `systemctl ${action} ${shq(unit)} && systemctl status ${shq(unit)} --no-pager --lines=10`;
            return formatExec(await runTrusted(cfg, cmd, 90), { label: `systemctl ${action} ${unit}` });
        },
    );

    defineTool(
        server,
        cfg,
        'journal_logs',
        {
            title: 'Read journald logs',
            description:
                'Read systemd journal logs, optionally for one unit. Use "since" for time windows ' +
                '("10 min ago", "today") and "grep" to filter.',
            inputSchema: z.object({
                unit: z.string().optional().describe('Limit to this unit, e.g. "nginx".'),
                lines: z.number().int().positive().max(5000).optional().describe('Number of lines. Default 200.'),
                since: z.string().optional().describe('journalctl --since value, e.g. "1 hour ago".'),
                priority: z.string().optional().describe('Max priority, e.g. "err" or "warning".'),
                grep: z.string().optional().describe('Only lines matching this pattern.'),
            }),
        },
        async args => {
            const parts = ['journalctl', '--no-pager'];
            if (args['unit']) parts.push('-u', shq(String(args['unit'])));
            parts.push('-n', String((args['lines'] as number | undefined) ?? 200));
            if (args['since']) parts.push('--since', shq(String(args['since'])));
            if (args['priority']) parts.push('-p', shq(String(args['priority'])));
            if (args['grep']) parts.push('--grep', shq(String(args['grep'])));
            const cmd = parts.join(' ');
            const r = await runTrusted(cfg, cmd, 60);
            return text(`$ ${cmd}\n${r.stdout.trimEnd() || r.stderr.trimEnd() || '(no matching log entries)'}`);
        },
    );

    defineTool(
        server,
        cfg,
        'list_processes',
        {
            title: 'List processes',
            description: 'List running processes, optionally filtered by a pattern, sorted by CPU or memory.',
            inputSchema: z.object({
                filter: z.string().optional().describe('Only processes whose command line matches this pattern.'),
                sort_by: z.enum(['cpu', 'mem']).optional().describe('Sort key. Default cpu.'),
                limit: z.number().int().positive().max(200).optional().describe('Rows to return. Default 30.'),
            }),
        },
        async args => {
            const sort = args['sort_by'] === 'mem' ? '-pmem' : '-pcpu';
            const limit = (args['limit'] as number | undefined) ?? 30;
            const filter = args['filter'] as string | undefined;
            const base = `ps -eo pid,ppid,user,pmem,pcpu,etime,args --sort=${sort}`;
            const cmd = filter
                ? `${base} | head -1; ${base} | tail -n +2 | grep -i -- ${shq(filter)} | head -${limit}`
                : `${base} | head -${limit + 1}`;
            const r = await runTrusted(cfg, cmd, 30);
            return text(r.stdout.trimEnd() || '(no matching processes)');
        },
    );

    defineTool(
        server,
        cfg,
        'list_ports',
        {
            title: 'List listening ports',
            description: 'Show listening TCP/UDP sockets with the owning process. Use to see what is exposed and by what.',
            inputSchema: z.object({}),
        },
        async () => {
            const r = await runTrusted(cfg, 'ss -tulpnH 2>/dev/null || netstat -tulpn 2>/dev/null', 30);
            return text(r.stdout.trimEnd() || r.stderr.trimEnd() || '(no listening sockets found)');
        },
    );

    defineTool(
        server,
        cfg,
        'tail_file',
        {
            title: 'Tail a log file',
            description:
                'Read the last N lines of a file, optionally filtered. Intended for log files too large to read whole.',
            inputSchema: z.object({
                path: z.string().describe('Absolute host path, e.g. "/var/log/nginx/error.log".'),
                lines: z.number().int().positive().max(5000).optional().describe('Lines from the end. Default 100.'),
                grep: z.string().optional().describe('Only lines matching this pattern (applied before tailing).'),
            }),
        },
        async args => {
            // Authorised through the container view so the RC_ALLOWED_PATHS sandbox applies,
            // then spelled for whichever namespace the shell actually runs in.
            const resolved = await resolvePath(cfg, String(args['path']));
            const target = pathForShell(cfg, resolved);
            const lines = (args['lines'] as number | undefined) ?? 100;
            const grep = args['grep'] as string | undefined;
            const cmd = grep
                ? `grep -i -- ${shq(grep)} ${shq(target)} | tail -n ${lines}`
                : `tail -n ${lines} ${shq(target)}`;
            const r = await runTrusted(cfg, cmd, 60);
            if (r.exitCode !== 0 && !r.stdout.trim()) {
                return text(`$ ${cmd}\n${r.stderr.trimEnd() || '(no matching lines)'}`);
            }
            const suffix = grep ? `, matching ${grep}` : '';
            return text(`${resolved.host} (last ${lines} lines${suffix}):\n\n${r.stdout.trimEnd()}`);
        },
    );
}
