/**
 * The activity app: one shared ui:// resource that messageoperator_bash and
 * messageoperator_view render as an outcomes & alerts card. Claude Desktop mounts
 * app iframes only after the tool call completes (verified empirically:
 * toolinput/toolresult are replayed within ~50ms of mount), so everything
 * the card shows — outcomes, alerts, step timings — travels in the tool
 * result's structuredContent; there are no app-only tools and no polling.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function distPath(...parts: string[]): string {
  // compiled location is dist/apps/activity.js — dist/ is one level up
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ...parts,
  );
}

function buildHash(): string {
  try {
    const info = JSON.parse(
      fs.readFileSync(distPath("build-info.json"), "utf-8"),
    );
    return String(info.srcHash);
  } catch {
    return "dev";
  }
}

/**
 * Versioned by build hash: hosts cache ui:// resources by URI across
 * reinstalls, so every build must claim a fresh URI.
 */
export function activityUri(): string {
  return `ui://messageoperator/activity-${buildHash()}.html`;
}

export function registerActivityAppParts(mcp: McpServer): void {
  const uri = activityUri();

  registerAppResource(mcp, "Message Operator activity", uri, {}, async () => ({
    contents: [
      {
        uri,
        mimeType: RESOURCE_MIME_TYPE,
        text: fs.readFileSync(distPath("ui", "activity.html"), "utf-8"),
        _meta: {
          ui: {
            prefersBorder: false,
            // lets applyHostFonts load Anthropic Sans (the host's own UI
            // font) so body text hints crisply; everything else is inlined
            csp: { resourceDomains: ["https://assets.claude.ai"] },
          },
        },
      },
    ],
  }));
}
