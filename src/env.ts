/**
 * The one env prefix the codebase reads.
 *
 * No imports: cli.ts keeps its module scope to Node built-ins so the serve
 * path reaches the MCP handshake without the provider dependency graph.
 */

export const ENV_PREFIX = "MESSAGEOPERATOR_";
