/**
 * Catastrophic-command seatbelt.
 *
 * This is protection against an honest mistake, NOT a security boundary. Anyone
 * holding the bearer token already has root on the host and can trivially write an
 * equivalent command these patterns do not match. The real boundaries are the token
 * itself, RC_READONLY, and RC_ALLOWED_PATHS.
 */
export const DEFAULT_BLOCKED_PATTERNS: string[] = [
    // `rm -rf /` and `rm -rf /*`, but deliberately NOT `rm -rf /tmp/foo`, which is routine.
    String.raw`\brm\s+(?:-\S+\s+)*(?:/|/\*)(?:\s|$)`,
    String.raw`--no-preserve-root`,
    String.raw`\bmkfs(?:\.\w+)?\s`,
    String.raw`\bdd\b[^\r\n]*\bof=/dev/(?:sd|nvme|vd|hd|xvd)`,
    String.raw`>\s*/dev/(?:sd|nvme|vd|hd|xvd)\w`,
    // Anchored to command position, so `grep reboot /var/log/syslog` and
    // `systemctl status reboot.target` are not caught.
    String.raw`(?:^|[;&|]\s*|\bsudo\s+)(?:shutdown|reboot|poweroff|halt)(?:\s|$)`,
    // Classic fork bomb.
    String.raw`:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;\s*:`,
    String.raw`\bchmod\s+-R\s+(?:777|000)\s+/\s*$`,
];

export function compilePatterns(sources: string[]): RegExp[] {
    return sources.map(src => {
        try {
            return new RegExp(src, 'i');
        } catch (err) {
            throw new Error(`Invalid blocked-command pattern ${JSON.stringify(src)}: ${(err as Error).message}`);
        }
    });
}

/** Returns the offending pattern's source, or null when the command is allowed. */
export function findBlockedPattern(command: string, patterns: RegExp[]): string | null {
    for (const re of patterns) {
        re.lastIndex = 0;
        if (re.test(command)) return re.source;
    }
    return null;
}
