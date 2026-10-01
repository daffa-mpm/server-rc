/**
 * Verifies the containment controls actually contain: RC_READONLY, RC_ALLOWED_PATHS,
 * RC_DENIED_PATHS and RC_TOOLSETS. Run against a server started with those set.
 *
 *   node scripts/test-restrictions.mjs <url> <token>
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = process.argv[2] ?? 'http://127.0.0.1:8724/mcp';
const token = process.argv[3];
if (!token) {
    console.error('usage: node scripts/test-restrictions.mjs <url> <token>');
    process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};
const textOf = r => (r.content ?? []).map(c => c.text ?? '').join('\n');

const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'restriction-test', version: '1.0.0' });
await client.connect(transport);

console.log('\n== toolset gating (RC_TOOLSETS=files,system) ==');
const { tools } = await client.listTools();
const names = tools.map(t => t.name);
check('docker tools are absent', !names.some(n => n.startsWith('docker_')), names.join(','));
check('run_command is absent', !names.includes('run_command'), names.join(','));
check('file tools are present', names.includes('read_file'));
check('system tools are present', names.includes('system_overview'));

console.log('\n== read-only mode (RC_READONLY=true) ==');
{
    const r = await client.callTool({ name: 'write_file', arguments: { path: '/srv/allowed/x.txt', content: 'x' } });
    check('write_file is refused', r.isError === true && /RC_READONLY/.test(textOf(r)), textOf(r).slice(0, 200));
}
{
    const r = await client.callTool({
        name: 'edit_file',
        arguments: { path: '/srv/allowed/seed.txt', old_string: 'seed', new_string: 'x' },
    });
    check('edit_file is refused', r.isError === true && /RC_READONLY/.test(textOf(r)), textOf(r).slice(0, 200));
}
{
    const r = await client.callTool({ name: 'read_file', arguments: { path: '/srv/allowed/seed.txt' } });
    check('read_file still works', !r.isError && textOf(r).includes('seed'), textOf(r).slice(0, 200));
}

console.log('\n== path sandbox (RC_ALLOWED_PATHS=/srv/allowed, RC_DENIED_PATHS=/srv/allowed/secret) ==');
for (const [label, p] of [
    ['/etc/shadow', '/etc/shadow'],
    ['/root', '/root'],
    ['parent escape via ..', '/srv/allowed/../../etc/hostname'],
    ['denied subdirectory', '/srv/allowed/secret/key.txt'],
]) {
    const r = await client.callTool({ name: 'read_file', arguments: { path: p } });
    check(`reading ${label} is denied`, r.isError === true && /allowed roots|denied root/i.test(textOf(r)), textOf(r).slice(0, 200));
}
{
    const r = await client.callTool({ name: 'list_dir', arguments: { path: '/etc' } });
    check('list_dir outside the sandbox is denied', r.isError === true, textOf(r).slice(0, 200));
}
{
    const r = await client.callTool({ name: 'read_file', arguments: { path: '/srv/allowed/seed.txt' } });
    check('reading inside the sandbox is allowed', !r.isError, textOf(r).slice(0, 200));
}
{
    // The interesting case: a symlink inside the sandbox pointing outside it.
    const r = await client.callTool({ name: 'read_file', arguments: { path: '/srv/allowed/escape-link' } });
    check(
        'symlink escaping the sandbox is denied',
        r.isError === true && /allowed roots/i.test(textOf(r)),
        textOf(r).slice(0, 200),
    );
}
{
    const r = await client.callTool({ name: 'tail_file', arguments: { path: '/etc/hostname' } });
    check('tail_file honours the sandbox', r.isError === true, textOf(r).slice(0, 200));
}

await client.close();
console.log(`\n${'='.repeat(50)}\n${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
process.exit(fail === 0 ? 0 : 1);
