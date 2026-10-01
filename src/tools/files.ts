import fsp from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { resolvePath, pathForShell } from '../paths.js';
import { runTrusted, shq } from '../exec.js';
import { defineTool, text } from './common.js';

const MAX_READ_BYTES = 1_000_000;

function mode(m: number): string {
    return '0' + (m & 0o777).toString(8);
}

function human(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${i === 0 ? n : n.toFixed(1)}${units[i]}`;
}

export function registerFileTools(server: McpServer, cfg: Config): void {
    defineTool(
        server,
        cfg,
        'read_file',
        {
            title: 'Read file',
            description:
                'Read a text file from the host, with optional line range. Returns numbered lines. ' +
                'For very large logs prefer tail_file. For binary files use download_file.',
            inputSchema: z.object({
                path: z.string().describe('Absolute host path, e.g. "/etc/nginx/nginx.conf".'),
                offset: z.number().int().nonnegative().optional().describe('First line to return (1-based). Default 1.'),
                limit: z.number().int().positive().max(10000).optional().describe('Maximum lines to return. Default 2000.'),
            }),
        },
        async args => {
            const r = await resolvePath(cfg, String(args['path']));
            const st = await fsp.stat(r.container);
            if (st.isDirectory()) throw new Error(`${r.host} is a directory -- use list_dir.`);
            if (st.size > MAX_READ_BYTES) {
                throw new Error(
                    `${r.host} is ${human(st.size)}, over the ${human(MAX_READ_BYTES)} read limit. ` +
                    `Use tail_file, or read_file with offset/limit.`,
                );
            }
            const raw = await fsp.readFile(r.container);
            if (raw.includes(0)) {
                throw new Error(`${r.host} looks binary (${human(st.size)}). Use download_file instead.`);
            }
            const all = raw.toString('utf8').split('\n');
            const offset = Math.max(1, (args['offset'] as number | undefined) ?? 1);
            const limit = (args['limit'] as number | undefined) ?? 2000;
            const slice = all.slice(offset - 1, offset - 1 + limit);
            const width = String(offset + slice.length - 1).length;
            const body = slice.map((l, i) => `${String(offset + i).padStart(width)}\t${l}`).join('\n');
            const shown = `lines ${offset}-${offset + slice.length - 1} of ${all.length}`;
            return text(`${r.host} (${human(st.size)}, ${shown}):\n\n${body}`);
        },
    );

    defineTool(
        server,
        cfg,
        'write_file',
        {
            title: 'Write file',
            description:
                'Create or overwrite a file on the host with the given content. Parent directories are created. ' +
                'To change part of an existing file, prefer edit_file so the rest is preserved.',
            mutating: true,
            inputSchema: z.object({
                path: z.string().describe('Absolute host path to write.'),
                content: z.string().describe('Full file content.'),
                mode: z.string().optional().describe('Octal permissions, e.g. "0644". Only applied to new files.'),
                backup: z.boolean().optional()
                    .describe('If true and the file exists, copy it to <path>.bak-<timestamp> first. Default false.'),
            }),
        },
        async args => {
            const r = await resolvePath(cfg, String(args['path']));
            const content = String(args['content']);
            let note = '';

            let existed = true;
            try {
                await fsp.access(r.container);
            } catch {
                existed = false;
            }

            if (existed && args['backup'] === true) {
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                const bak = `${r.container}.bak-${stamp}`;
                await fsp.copyFile(r.container, bak);
                note = `\nBacked up previous content to ${r.host}.bak-${stamp}`;
            }

            await fsp.mkdir(path.posix.dirname(r.container), { recursive: true });
            await fsp.writeFile(r.container, content, 'utf8');
            if (!existed && args['mode']) {
                await fsp.chmod(r.container, Number.parseInt(String(args['mode']), 8));
            }
            const verb = existed ? 'Overwrote' : 'Created';
            return text(
                `${verb} ${r.host} (${human(Buffer.byteLength(content))}, ${content.split('\n').length} lines).${note}`,
            );
        },
    );

    defineTool(
        server,
        cfg,
        'edit_file',
        {
            title: 'Edit file',
            description:
                'Replace an exact string in a file, leaving everything else untouched. ' +
                'old_string must appear exactly once unless replace_all is true. ' +
                'This is the safe way to change a config file.',
            mutating: true,
            inputSchema: z.object({
                path: z.string().describe('Absolute host path to edit.'),
                old_string: z.string().describe('Exact text to replace, including indentation.'),
                new_string: z.string().describe('Replacement text.'),
                replace_all: z.boolean().optional().describe('Replace every occurrence. Default false.'),
            }),
        },
        async args => {
            const r = await resolvePath(cfg, String(args['path']));
            const oldStr = String(args['old_string']);
            const newStr = String(args['new_string']);
            if (oldStr === newStr) throw new Error('old_string and new_string are identical -- nothing to do.');

            const before = await fsp.readFile(r.container, 'utf8');
            const count = before.split(oldStr).length - 1;
            if (count === 0) {
                throw new Error(
                    `old_string was not found in ${r.host}. Read the file first and copy the text exactly, ` +
                    `including whitespace.`,
                );
            }
            if (count > 1 && args['replace_all'] !== true) {
                throw new Error(
                    `old_string appears ${count} times in ${r.host}. Include more surrounding context to make it ` +
                    `unique, or pass replace_all: true.`,
                );
            }
            const after = args['replace_all'] === true
                ? before.split(oldStr).join(newStr)
                : before.replace(oldStr, newStr);
            await fsp.writeFile(r.container, after, 'utf8');
            const replaced = args['replace_all'] === true ? count : 1;
            return text(`Edited ${r.host}: replaced ${replaced} occurrence${replaced === 1 ? '' : 's'}.`);
        },
    );

    defineTool(
        server,
        cfg,
        'list_dir',
        {
            title: 'List directory',
            description: 'List a directory with type, size, permissions, owner and modification time.',
            inputSchema: z.object({
                path: z.string().describe('Absolute host directory, e.g. "/srv".'),
                all: z.boolean().optional().describe('Include dotfiles. Default true.'),
                limit: z.number().int().positive().max(2000).optional().describe('Max entries. Default 500.'),
            }),
        },
        async args => {
            const r = await resolvePath(cfg, String(args['path']));
            const entries = await fsp.readdir(r.container, { withFileTypes: true });
            const includeHidden = args['all'] !== false;
            const limit = (args['limit'] as number | undefined) ?? 500;
            const visible = entries.filter(e => includeHidden || !e.name.startsWith('.'));
            visible.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

            const rows: string[] = [];
            for (const e of visible.slice(0, limit)) {
                const full = path.posix.join(r.container, e.name);
                try {
                    const st = await fsp.lstat(full);
                    const kind = e.isDirectory() ? 'dir ' : e.isSymbolicLink() ? 'link' : 'file';
                    const size = e.isDirectory() ? '-' : human(st.size);
                    const when = st.mtime.toISOString().slice(0, 16).replace('T', ' ');
                    let name = e.name;
                    if (e.isSymbolicLink()) {
                        try {
                            name += ` -> ${await fsp.readlink(full)}`;
                        } catch { /* broken link; show the name alone */ }
                    }
                    rows.push(
                        `${kind}  ${mode(st.mode)}  ${String(st.uid)}:${String(st.gid)}  ` +
                        `${size.padStart(8)}  ${when}  ${name}`,
                    );
                } catch {
                    rows.push(`????  ${e.name}  (stat failed)`);
                }
            }
            const more = visible.length > limit ? `\n\n... ${visible.length - limit} more entries not shown.` : '';
            const body = rows.length ? rows.join('\n') : '(empty directory)';
            return text(`${r.host} -- ${visible.length} entries\n\ntype  mode   uid:gid  size      modified          name\n${body}${more}`);
        },
    );

    defineTool(
        server,
        cfg,
        'search_files',
        {
            title: 'Search file contents',
            description:
                'Recursively search files for a pattern (grep). Returns matching lines with file and line number. ' +
                'Use this to find which config mentions a setting.',
            inputSchema: z.object({
                pattern: z.string().describe('Pattern to search for. Treated as a regular expression.'),
                path: z.string().describe('Absolute host directory to search under.'),
                glob: z.string().optional().describe('Only files matching this name pattern, e.g. "*.conf".'),
                ignore_case: z.boolean().optional().describe('Case-insensitive search. Default true.'),
                limit: z.number().int().positive().max(1000).optional().describe('Max matching lines. Default 100.'),
            }),
        },
        async args => {
            const r = await resolvePath(cfg, String(args['path']));
            const target = pathForShell(cfg, r);
            const limit = (args['limit'] as number | undefined) ?? 100;
            const flags = ['-rnI', args['ignore_case'] === false ? '' : '-i'].filter(Boolean).join(' ');
            const include = args['glob'] ? `--include=${shq(String(args['glob']))}` : '';
            const cmd =
                `grep ${flags} ${include} -E -- ${shq(String(args['pattern']))} ${shq(target)} 2>/dev/null | head -n ${limit}`;
            const res = await runTrusted(cfg, cmd, 120);
            const out = res.stdout.trimEnd();
            if (!out) return text(`No matches for ${String(args['pattern'])} under ${r.host}.`);
            const lines = out.split('\n').length;
            const capped = lines >= limit ? `\n\n(stopped at ${limit} matches -- narrow the pattern or path for more)` : '';
            return text(`${lines} matching line(s) under ${r.host}:\n\n${out}${capped}`);
        },
    );

    defineTool(
        server,
        cfg,
        'file_info',
        {
            title: 'File info',
            description: 'Stat a path: type, size, permissions, owner, timestamps, and for directories the entry count.',
            inputSchema: z.object({ path: z.string().describe('Absolute host path.') }),
        },
        async args => {
            const r = await resolvePath(cfg, String(args['path']));
            const st = await fsp.lstat(r.container);
            const kind = st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'special';
            const rows = [
                `path:     ${r.host}`,
                `type:     ${kind}`,
                `size:     ${human(st.size)} (${st.size} bytes)`,
                `mode:     ${mode(st.mode)}`,
                `owner:    uid=${st.uid} gid=${st.gid}`,
                `modified: ${st.mtime.toISOString()}`,
                `accessed: ${st.atime.toISOString()}`,
                `changed:  ${st.ctime.toISOString()}`,
            ];
            if (st.isSymbolicLink()) rows.push(`target:   ${await fsp.readlink(r.container)}`);
            if (st.isDirectory()) rows.push(`entries:  ${(await fsp.readdir(r.container)).length}`);
            return text(rows.join('\n'));
        },
    );

    defineTool(
        server,
        cfg,
        'download_file',
        {
            title: 'Download file',
            description:
                'Return a file base64-encoded, for binaries or for copying a file back to the local machine. ' +
                'Limited to 5MB; for anything larger, archive and split it on the host first.',
            inputSchema: z.object({ path: z.string().describe('Absolute host path to download.') }),
        },
        async args => {
            const r = await resolvePath(cfg, String(args['path']));
            const st = await fsp.stat(r.container);
            const cap = 5 * 1024 * 1024;
            if (st.size > cap) {
                throw new Error(`${r.host} is ${human(st.size)}, over the ${human(cap)} download limit.`);
            }
            const buf = await fsp.readFile(r.container);
            return text(`${r.host} (${human(st.size)}, base64):\n\n${buf.toString('base64')}`);
        },
    );

    defineTool(
        server,
        cfg,
        'upload_file',
        {
            title: 'Upload file',
            description: 'Write a base64-encoded payload to a host path. Use for binaries; for text prefer write_file.',
            mutating: true,
            inputSchema: z.object({
                path: z.string().describe('Absolute host path to write.'),
                content_base64: z.string().describe('Base64-encoded file content.'),
                mode: z.string().optional().describe('Octal permissions for a new file, e.g. "0755".'),
            }),
        },
        async args => {
            const r = await resolvePath(cfg, String(args['path']));
            const buf = Buffer.from(String(args['content_base64']), 'base64');
            await fsp.mkdir(path.posix.dirname(r.container), { recursive: true });
            await fsp.writeFile(r.container, buf);
            if (args['mode']) await fsp.chmod(r.container, Number.parseInt(String(args['mode']), 8));
            return text(`Wrote ${human(buf.byteLength)} to ${r.host}.`);
        },
    );

    defineTool(
        server,
        cfg,
        'delete_path',
        {
            title: 'Delete file or directory',
            description:
                'Delete a file, or a directory with recursive: true. Disabled unless the server sets ' +
                'RC_ALLOW_DELETE=true. This is not recoverable -- confirm with the user before calling it.',
            mutating: true,
            inputSchema: z.object({
                path: z.string().describe('Absolute host path to delete.'),
                recursive: z.boolean().optional().describe('Required to delete a non-empty directory. Default false.'),
            }),
        },
        async args => {
            if (!cfg.allowDelete) {
                throw new Error(
                    'Deletion is disabled on this server (RC_ALLOW_DELETE=false). ' +
                    'Delete it manually, or enable the flag and restart the container.',
                );
            }
            const r = await resolvePath(cfg, String(args['path']));
            if (r.host === '/') throw new Error('Refusing to delete /.');
            const st = await fsp.lstat(r.container);
            if (st.isDirectory() && args['recursive'] !== true) {
                throw new Error(`${r.host} is a directory. Pass recursive: true to delete it and its contents.`);
            }
            await fsp.rm(r.container, { recursive: args['recursive'] === true, force: false });
            return text(`Deleted ${r.host}.`);
        },
    );
}
