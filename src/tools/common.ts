import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { audit } from '../audit.js';
import type { ExecResult } from '../exec.js';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export function text(s: string): ToolResult {
    return { content: [{ type: 'text', text: s }] };
}

export function errorText(s: string): ToolResult {
    return { content: [{ type: 'text', text: s }], isError: true };
}

/** Render an ExecResult the way a human reads a terminal: output first, status last. */
export function formatExec(r: ExecResult, opts: { label?: string } = {}): ToolResult {
    const parts: string[] = [];
    if (opts.label) parts.push(`$ ${opts.label}`);
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);

    const status: string[] = [`exit=${r.exitCode ?? 'null'}`, `${r.durationMs}ms`];
    if (r.signal) status.push(`signal=${r.signal}`);
    if (r.timedOut) status.push('TIMED OUT');
    if (r.truncated) status.push('output truncated');
    parts.push(`[${status.join(' | ')}]`);

    if (!r.stdout.trim() && !r.stderr.trim()) {
        parts.splice(opts.label ? 1 : 0, 0, '(no output)');
    }
    const body = parts.join('\n');
    return r.exitCode === 0 && !r.timedOut ? text(body) : { content: [{ type: 'text', text: body }], isError: true };
}

export interface ToolSpec {
    title?: string;
    description: string;
    inputSchema?: unknown;
    /** Writes to the host. Refused when RC_READONLY is set. */
    mutating?: boolean;
    annotations?: Record<string, unknown>;
}

/**
 * Register a tool with uniform audit logging, read-only enforcement and error
 * handling, so no individual tool has to remember any of it.
 */
export function defineTool(
    server: McpServer,
    cfg: Config,
    name: string,
    spec: ToolSpec,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
): void {
    const annotations = {
        readOnlyHint: !spec.mutating,
        destructiveHint: Boolean(spec.mutating),
        openWorldHint: true,
        ...(spec.annotations ?? {}),
    };

    const wrapped = async (args: Record<string, unknown>): Promise<ToolResult> => {
        const started = Date.now();
        try {
            if (spec.mutating && cfg.readonly) {
                throw new Error(
                    `${name} modifies the host, but this server runs with RC_READONLY=true. ` +
                    `Unset RC_READONLY on the server to allow writes.`,
                );
            }
            const out = await handler(args);
            audit({ ts: new Date().toISOString(), tool: name, args, ok: !out.isError, ms: Date.now() - started });
            return out;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            audit({ ts: new Date().toISOString(), tool: name, args, ok: false, ms: Date.now() - started, error: message });
            return errorText(message);
        }
    };

    const config: Record<string, unknown> = { description: spec.description, annotations };
    if (spec.title) config['title'] = spec.title;
    if (spec.inputSchema) config['inputSchema'] = spec.inputSchema;

    // The SDK's generic signature is driven by the schema type; our registry is
    // deliberately uniform, so we hand it the runtime shape it expects.
    (server.registerTool as unknown as (n: string, c: unknown, h: unknown) => void)(name, config, wrapped);
}
