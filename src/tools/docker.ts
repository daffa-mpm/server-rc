import fsp from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { runLocal, shq } from '../exec.js';
import { resolvePath } from '../paths.js';
import { defineTool, formatExec, text } from './common.js';

const PS_FORMAT = 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}\\t{{.Ports}}';

export function registerDockerTools(server: McpServer, cfg: Config): void {
    defineTool(
        server,
        cfg,
        'docker_ps',
        {
            title: 'List containers',
            description: 'List Docker containers with name, status, image and published ports.',
            inputSchema: z.object({
                all: z.boolean().optional().describe('Include stopped containers. Default false.'),
                filter: z.string().optional().describe('Docker filter, e.g. "name=api" or "status=exited".'),
            }),
        },
        async args => {
            const parts = ['docker ps', `--format ${shq(PS_FORMAT)}`];
            if (args['all'] === true) parts.push('-a');
            if (args['filter']) parts.push('--filter', shq(String(args['filter'])));
            const r = await runLocal(cfg, parts.join(' '), 30);
            return r.exitCode === 0
                ? text(r.stdout.trimEnd() || '(no containers)')
                : formatExec(r, { label: 'docker ps' });
        },
    );

    defineTool(
        server,
        cfg,
        'docker_logs',
        {
            title: 'Container logs',
            description: 'Read a container\'s logs. Never follows -- pass "since" and "tail" to bound the output.',
            inputSchema: z.object({
                container: z.string().describe('Container name or ID.'),
                tail: z.number().int().positive().max(5000).optional().describe('Lines from the end. Default 200.'),
                since: z.string().optional().describe('Only logs since this time, e.g. "10m" or "2026-10-01T08:00:00".'),
                grep: z.string().optional().describe('Only lines matching this pattern.'),
            }),
        },
        async args => {
            const parts = ['docker logs', '--timestamps', `--tail ${(args['tail'] as number | undefined) ?? 200}`];
            if (args['since']) parts.push('--since', shq(String(args['since'])));
            parts.push(shq(String(args['container'])));
            // Docker writes container logs to stderr as well as stdout; merge before filtering.
            let cmd = `${parts.join(' ')} 2>&1`;
            if (args['grep']) cmd += ` | grep -i -- ${shq(String(args['grep']))}`;
            const r = await runLocal(cfg, cmd, 60);
            return text(`$ ${cmd}\n${r.stdout.trimEnd() || '(no log output)'}`);
        },
    );

    defineTool(
        server,
        cfg,
        'docker_inspect',
        {
            title: 'Inspect container',
            description:
                'Inspect a container: image, state, restart count, mounts, networks, env and health. ' +
                'Use when you need to know how a container is configured.',
            inputSchema: z.object({
                container: z.string().describe('Container name or ID.'),
                full: z.boolean().optional().describe('Return the raw full JSON instead of a summary. Default false.'),
            }),
        },
        async args => {
            const name = shq(String(args['container']));
            if (args['full'] === true) {
                const r = await runLocal(cfg, `docker inspect ${name}`, 30);
                return formatExec(r, { label: `docker inspect ${String(args['container'])}` });
            }
            const fmt =
                'Name: {{.Name}}\\nImage: {{.Config.Image}}\\nState: {{.State.Status}} ' +
                '(exit {{.State.ExitCode}})\\nStarted: {{.State.StartedAt}}\\nRestarts: {{.RestartCount}}\\n' +
                'Health: {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\\n' +
                'RestartPolicy: {{.HostConfig.RestartPolicy.Name}}';
            const cmd =
                `docker inspect --format ${shq(fmt)} ${name}; ` +
                `echo; echo "--- Mounts ---"; docker inspect --format ` +
                `${shq('{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Mode}}){{"\\n"}}{{end}}')} ${name}; ` +
                `echo "--- Networks ---"; docker inspect --format ` +
                `${shq('{{range $k,$v := .NetworkSettings.Networks}}{{$k}}: {{$v.IPAddress}}{{"\\n"}}{{end}}')} ${name}`;
            const r = await runLocal(cfg, cmd, 30);
            return r.exitCode === 0 ? text(r.stdout.trimEnd()) : formatExec(r, { label: 'docker inspect' });
        },
    );

    defineTool(
        server,
        cfg,
        'docker_action',
        {
            title: 'Start/stop/restart container',
            description: 'Start, stop, restart, pause, unpause or kill a container, then report its new status.',
            mutating: true,
            inputSchema: z.object({
                container: z.string().describe('Container name or ID.'),
                action: z.enum(['start', 'stop', 'restart', 'pause', 'unpause', 'kill']).describe('What to do.'),
            }),
        },
        async args => {
            const name = String(args['container']);
            const action = String(args['action']);
            const cmd =
                `docker ${action} ${shq(name)} && docker ps -a --filter name=^/${name}$ --format ${shq(PS_FORMAT)}`;
            return formatExec(await runLocal(cfg, cmd, 120), { label: `docker ${action} ${name}` });
        },
    );

    defineTool(
        server,
        cfg,
        'docker_exec',
        {
            title: 'Run command in container',
            description:
                'Run a command inside a running container (docker exec). Non-interactive. ' +
                'Use run_command instead for anything on the host itself.',
            mutating: true,
            inputSchema: z.object({
                container: z.string().describe('Container name or ID.'),
                command: z.string().describe('Command to run inside the container.'),
                user: z.string().optional().describe('User to run as, e.g. "root".'),
                workdir: z.string().optional().describe('Working directory inside the container.'),
                timeout_sec: z.number().int().positive().optional().describe('Seconds before the command is killed.'),
            }),
        },
        async args => {
            const parts = ['docker exec'];
            if (args['user']) parts.push('-u', shq(String(args['user'])));
            if (args['workdir']) parts.push('-w', shq(String(args['workdir'])));
            parts.push(shq(String(args['container'])), 'sh', '-c', shq(String(args['command'])));
            const cmd = parts.join(' ');
            const r = await runLocal(cfg, cmd, args['timeout_sec'] as number | undefined);
            return formatExec(r, { label: cmd });
        },
    );

    defineTool(
        server,
        cfg,
        'docker_compose',
        {
            title: 'Run docker compose',
            description:
                'Run a docker compose subcommand in a project directory, e.g. "ps", "up -d", "down", ' +
                '"logs --tail 100", "pull", "restart <service>".',
            mutating: true,
            inputSchema: z.object({
                project_dir: z.string().describe('Absolute host directory containing the compose file.'),
                args: z.string().describe('Subcommand and flags, e.g. "up -d" or "logs --tail 50 api".'),
                timeout_sec: z.number().int().positive().optional().describe('Seconds before the command is killed. Default 300.'),
            }),
        },
        async args => {
            const r = await resolvePath(cfg, String(args['project_dir']));
            const sub = String(args['args']);

            // Compose runs in this container (reading the file through RC_HOST_ROOT) but
            // the daemon it talks to is the host's. Relative bind mounts must therefore
            // resolve against the HOST directory, not our view of it -- otherwise the
            // daemon is handed /host/... paths that do not exist on the host. That is
            // exactly what --project-directory is for.
            const entries = await fsp.readdir(r.container).catch(() => {
                throw new Error(`${r.host} is not a readable directory.`);
            });
            const base = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
                .find(n => entries.includes(n));
            if (!base) {
                throw new Error(
                    `No compose file in ${r.host} (looked for compose.yaml, compose.yml, ` +
                    `docker-compose.yaml, docker-compose.yml).`,
                );
            }
            const override = ['compose.override.yaml', 'compose.override.yml',
                'docker-compose.override.yaml', 'docker-compose.override.yml']
                .find(n => entries.includes(n));

            const files = [`-f ${shq(path.posix.join(r.container, base))}`];
            if (override) files.push(`-f ${shq(path.posix.join(r.container, override))}`);

            const cmd =
                `docker compose ${files.join(' ')} --project-directory ${shq(r.host)} ${sub} 2>&1`;
            const res = await runLocal(cfg, cmd, (args['timeout_sec'] as number | undefined) ?? 300);
            return formatExec(res, { label: `(${r.host}) docker compose ${sub}` });
        },
    );

    defineTool(
        server,
        cfg,
        'docker_stats',
        {
            title: 'Container resource usage',
            description: 'One-shot CPU, memory, network and disk I/O usage per running container.',
            inputSchema: z.object({}),
        },
        async () => {
            const fmt = 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.NetIO}}\\t{{.BlockIO}}';
            const r = await runLocal(cfg, `docker stats --no-stream --format ${shq(fmt)}`, 60);
            return r.exitCode === 0
                ? text(r.stdout.trimEnd() || '(no running containers)')
                : formatExec(r, { label: 'docker stats' });
        },
    );

    defineTool(
        server,
        cfg,
        'docker_images',
        {
            title: 'List images',
            description: 'List Docker images with size and age, plus total disk usage reclaimable by a prune.',
            inputSchema: z.object({}),
        },
        async () => {
            const fmt = 'table {{.Repository}}:{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}';
            const r = await runLocal(cfg, `docker images --format ${shq(fmt)}; echo; docker system df`, 60);
            return r.exitCode === 0 ? text(r.stdout.trimEnd()) : formatExec(r, { label: 'docker images' });
        },
    );
}
