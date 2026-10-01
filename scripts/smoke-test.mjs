/**
 * End-to-end smoke test: connects to a running server-remote-control over
 * Streamable HTTP exactly as Claude Code does, and exercises the real tools.
 *
 *   node scripts/smoke-test.mjs <url> <token>
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = process.argv[2] ?? 'http://127.0.0.1:8723/mcp';
const token = process.argv[3];
if (!token) {
    console.error('usage: node scripts/smoke-test.mjs <url> <token>');
    process.exit(2);
}

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
    if (ok) {
        pass++;
        console.log(`  PASS  ${name}`);
    } else {
        fail++;
        console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
    }
}

function textOf(res) {
    return (res.content ?? []).map(c => c.text ?? '').join('\n');
}

async function connect(bearer) {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const client = new Client({ name: 'smoke-test', version: '1.0.0' });
    await client.connect(transport);
    return client;
}

console.log(`\n== auth ==`);
try {
    await connect('wrong-token-that-is-at-least-32-characters-long');
    check('rejects a bad token', false, 'connection succeeded with a wrong token');
} catch (err) {
    check('rejects a bad token', /401|unauthor/i.test(String(err.message)), String(err.message).slice(0, 160));
}

const client = await connect(token);
check('accepts the correct token', true);

console.log(`\n== discovery ==`);
const { tools } = await client.listTools();
const names = tools.map(t => t.name).sort();
console.log(`  ${tools.length} tools: ${names.join(', ')}`);
check('exposes run_command', names.includes('run_command'));
check('exposes file tools', names.includes('read_file') && names.includes('edit_file'));
check('exposes docker tools', names.includes('docker_ps'));
check('exposes system tools', names.includes('system_overview'));
check('every tool has a description', tools.every(t => (t.description ?? '').length > 20));

console.log(`\n== shell ==`);
{
    const r = await client.callTool({ name: 'run_command', arguments: { command: 'echo hello-from-host; id -u' } });
    const t = textOf(r);
    check('run_command returns stdout', t.includes('hello-from-host'), t.slice(0, 200));
    check('run_command runs as root', /\b0\b/.test(t), t.slice(0, 200));
    check('run_command reports exit code', t.includes('exit=0'), t.slice(0, 200));
}
{
    const r = await client.callTool({ name: 'run_command', arguments: { command: 'echo out; echo err >&2; exit 3' } });
    const t = textOf(r);
    check('non-zero exit is flagged isError', r.isError === true);
    check('stderr is captured', t.includes('err'), t.slice(0, 200));
    check('exit code is surfaced', t.includes('exit=3'), t.slice(0, 200));
}
{
    const r = await client.callTool({ name: 'run_command', arguments: { command: 'sleep 30', timeout_sec: 2 } });
    const t = textOf(r);
    check('timeout kills the command', t.includes('TIMED OUT'), t.slice(0, 200));
}
{
    const r = await client.callTool({ name: 'run_command', arguments: { command: 'rm -rf /' } });
    const t = textOf(r);
    check('catastrophic command is refused', r.isError === true && /guard/i.test(t), t.slice(0, 200));
}
{
    const r = await client.callTool({ name: 'run_command', arguments: { command: 'rm -rf /tmp/src-guard-probe' } });
    check('ordinary rm -rf is allowed', r.isError !== true, textOf(r).slice(0, 200));
}
{
    const r = await client.callTool({ name: 'run_command', arguments: { command: 'cat', stdin: 'piped-input' } });
    check('stdin is piped through', textOf(r).includes('piped-input'), textOf(r).slice(0, 200));
}

console.log(`\n== files ==`);
const probe = '/tmp/src-smoke-probe.txt';
// Start from a known-clean state so the Created/Overwrote assertions are meaningful.
await client.callTool({ name: 'run_command', arguments: { command: `rm -f ${probe} ${probe}.bak-*` } });
{
    const r = await client.callTool({
        name: 'write_file',
        arguments: { path: probe, content: 'alpha\nbravo\ncharlie\n' },
    });
    check('write_file creates a new file', !r.isError && textOf(r).includes('Created'), textOf(r).slice(0, 200));
}
{
    const r = await client.callTool({
        name: 'write_file',
        arguments: { path: probe, content: 'alpha\nbravo\ncharlie\n', backup: true },
    });
    const t = textOf(r);
    check('write_file overwrites and reports it', !r.isError && t.includes('Overwrote'), t.slice(0, 200));
    check('write_file backup is taken when asked', t.includes('.bak-'), t.slice(0, 200));
}
{
    const r = await client.callTool({ name: 'read_file', arguments: { path: probe } });
    const t = textOf(r);
    check('read_file returns content', t.includes('bravo'), t.slice(0, 200));
    check('read_file numbers lines', /\b1\t/.test(t) || /1\s+alpha/.test(t), t.slice(0, 200));
}
{
    const r = await client.callTool({
        name: 'edit_file',
        arguments: { path: probe, old_string: 'bravo', new_string: 'BRAVO' },
    });
    check('edit_file replaces text', !r.isError, textOf(r).slice(0, 200));
    const after = textOf(await client.callTool({ name: 'read_file', arguments: { path: probe } }));
    check('edit_file preserved the rest', after.includes('BRAVO') && after.includes('alpha') && after.includes('charlie'));
}
{
    const r = await client.callTool({
        name: 'edit_file',
        arguments: { path: probe, old_string: 'nonexistent-text', new_string: 'x' },
    });
    check('edit_file errors on missing old_string', r.isError === true, textOf(r).slice(0, 200));
}
{
    const r = await client.callTool({ name: 'list_dir', arguments: { path: '/tmp' } });
    check('list_dir lists entries', textOf(r).includes('src-smoke-probe.txt'), textOf(r).slice(0, 300));
}
{
    const r = await client.callTool({ name: 'file_info', arguments: { path: probe } });
    check('file_info stats the file', textOf(r).includes('type:     file'), textOf(r).slice(0, 300));
}
{
    const r = await client.callTool({ name: 'search_files', arguments: { pattern: 'charlie', path: '/tmp' } });
    check('search_files finds matches', textOf(r).includes('charlie'), textOf(r).slice(0, 300));
}
{
    const r = await client.callTool({ name: 'tail_file', arguments: { path: probe, lines: 2 } });
    const t = textOf(r);
    check('tail_file returns the tail', t.includes('charlie') && !t.includes('alpha'), t.slice(0, 300));
}
{
    const r = await client.callTool({ name: 'download_file', arguments: { path: probe } });
    const t = textOf(r);
    const b64 = t.split('\n\n')[1] ?? '';
    check('download_file round-trips', Buffer.from(b64, 'base64').toString('utf8').includes('BRAVO'), t.slice(0, 200));
}
{
    const r = await client.callTool({ name: 'delete_path', arguments: { path: probe } });
    check('delete_path is disabled by default', r.isError === true && /RC_ALLOW_DELETE/.test(textOf(r)), textOf(r).slice(0, 200));
}
{
    const r = await client.callTool({ name: 'read_file', arguments: { path: '/etc/../etc/hostname' } });
    check('path traversal normalises safely', !r.isError, textOf(r).slice(0, 200));
}

console.log(`\n== system ==`);
{
    const r = await client.callTool({ name: 'system_overview', arguments: {} });
    const t = textOf(r);
    check('system_overview reports disk', t.includes('=== DISK ==='), t.slice(0, 200));
    check('system_overview reports memory', t.includes('=== MEMORY ==='), t.slice(0, 200));
    check('system_overview reports processes', t.includes('TOP 10 BY MEM'), t.slice(0, 200));
}
{
    const r = await client.callTool({ name: 'list_processes', arguments: { limit: 5 } });
    check('list_processes returns rows', textOf(r).split('\n').length > 2, textOf(r).slice(0, 200));
}
{
    const r = await client.callTool({ name: 'list_ports', arguments: {} });
    check('list_ports runs', typeof textOf(r) === 'string' && textOf(r).length > 0);
}

console.log(`\n== docker ==`);
{
    const r = await client.callTool({ name: 'docker_ps', arguments: { all: true } });
    const t = textOf(r);
    check('docker_ps reaches the daemon', t.includes('NAMES') || t.includes('no containers'), t.slice(0, 300));
}
{
    const r = await client.callTool({ name: 'docker_images', arguments: {} });
    check('docker_images reaches the daemon', textOf(r).includes('REPOSITORY') || textOf(r).includes('TYPE'), textOf(r).slice(0, 200));
}

console.log(`\n== docker compose (bind-mount path resolution) ==`);
{
    const dir = '/tmp/src-compose-probe';
    // A relative bind mount is the thing that breaks if compose resolves paths
    // against the container's view instead of the host's.
    const composeFile = [
        'services:',
        '  probe:',
        '    image: alpine:3',
        '    command: sh -c "echo mounted-ok > /data/marker.txt && sleep 30"',
        '    volumes:',
        '      - ./data:/data',
        '',
    ].join('\n');

    await client.callTool({ name: 'run_command', arguments: { command: `rm -rf ${dir}; mkdir -p ${dir}/data` } });
    await client.callTool({ name: 'write_file', arguments: { path: `${dir}/compose.yaml`, content: composeFile } });

    const up = await client.callTool({
        name: 'docker_compose',
        arguments: { project_dir: dir, args: 'up -d', timeout_sec: 180 },
    });
    check('docker compose up succeeds', !up.isError, textOf(up).slice(0, 400));

    // Give the container a moment to write through the bind mount.
    await new Promise(r => setTimeout(r, 3000));

    const marker = await client.callTool({ name: 'read_file', arguments: { path: `${dir}/data/marker.txt` } });
    check(
        'relative bind mount resolved to the HOST path',
        !marker.isError && textOf(marker).includes('mounted-ok'),
        textOf(marker).slice(0, 300),
    );

    const ps = await client.callTool({ name: 'docker_compose', arguments: { project_dir: dir, args: 'ps' } });
    check('docker compose ps lists the service', textOf(ps).includes('probe'), textOf(ps).slice(0, 300));

    const down = await client.callTool({
        name: 'docker_compose',
        arguments: { project_dir: dir, args: 'down -v', timeout_sec: 120 },
    });
    check('docker compose down succeeds', !down.isError, textOf(down).slice(0, 300));

    await client.callTool({ name: 'run_command', arguments: { command: `rm -rf ${dir}` } });
}

await client.close();

console.log(`\n${'='.repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('='.repeat(50));
process.exit(fail === 0 ? 0 : 1);
