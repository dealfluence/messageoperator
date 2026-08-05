/**
 * v0.6 rename (Mailroom → Message Operator): MESSAGEOPERATOR_* is the only
 * env prefix the codebase reads. Values under the pre-rename MAILROOM_*
 * names — injected by an old extension install or exported in a dev shell —
 * are adopted here once, at process start, so every other module stays
 * single-name. Canonical names win when both are set. Delete at 1.0.
 *
 * No imports: cli.ts keeps its module scope to Node built-ins so the serve
 * path reaches the MCP handshake without the provider dependency graph.
 */

export const ENV_PREFIX = "MESSAGEOPERATOR_";
export const LEGACY_ENV_PREFIX = "MAILROOM_";

export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const canonical = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
    if (env[canonical] === undefined) env[canonical] = value;
  }
}
