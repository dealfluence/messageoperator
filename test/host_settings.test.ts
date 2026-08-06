import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { probeHostSettings, recordEnvSnapshot } from "../src/host_settings.js";
import { tmpHome } from "./helpers.js";

const NOW = Date.now();

function settingsDir(): string {
  const dir = path.join(tmpHome(), "Claude Extensions Settings");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSettings(dir: string, body: unknown, mtimeMs: number): string {
  const file = path.join(dir, "local.mcpb.team-adeu.messageoperator.json");
  fs.writeFileSync(
    file,
    typeof body === "string" ? body : JSON.stringify(body),
  );
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

describe("probeHostSettings", () => {
  it("stays silent when the host leaves no settings store (other harnesses)", () => {
    const probe = probeHostSettings({
      env: {},
      dirs: [path.join(tmpHome(), "does-not-exist")],
      spawnMs: NOW,
    });
    expect(probe.file).toBeNull();
    expect(probe.changedSinceSpawn).toBe(false);
    expect(probe.staleClientId).toBe(false);
    expect(probe.notices).toEqual([]);
  });

  it("stays silent when the settings predate this server's start", () => {
    const dir = settingsDir();
    writeSettings(dir, { isEnabled: true }, NOW - 60_000);
    const probe = probeHostSettings({ env: {}, dirs: [dir], spawnMs: NOW });
    expect(probe.file).not.toBeNull();
    expect(probe.changedSinceSpawn).toBe(false);
    expect(probe.notices).toEqual([]);
  });

  it("stays silent about differing values under an UNCHANGED file — that is what running under another harness looks like", () => {
    const dir = settingsDir();
    writeSettings(
      dir,
      { isEnabled: true, userConfig: { microsoft_client_id: "cid-other" } },
      NOW - 60_000, // written before our spawn: not an edit we missed
    );
    const probe = probeHostSettings({
      env: { MESSAGEOPERATOR_MS_CLIENT_ID: "cid-live" },
      dirs: [dir],
      spawnMs: NOW,
    });
    expect(probe.staleClientId).toBe(false);
    expect(probe.notices).toEqual([]);
  });

  it("warns generically when the file changed after spawn but carries no readable values", () => {
    const dir = settingsDir();
    writeSettings(dir, { isEnabled: true }, NOW + 60_000);
    const probe = probeHostSettings({ env: {}, dirs: [dir], spawnMs: NOW });
    expect(probe.changedSinceSpawn).toBe(true);
    expect(probe.staleClientId).toBe(false);
    expect(probe.notices).toHaveLength(1);
    expect(probe.notices[0]).toMatch(/modified after this server started/);
    // host-hedged wording: Claude Desktop is conditional, not assumed
    expect(probe.notices[0]).toMatch(
      /if this server runs inside Claude Desktop/,
    );
    expect(probe.notices[0]).toMatch(/under another host/);
  });

  it("still warns when the changed file is not even JSON", () => {
    const dir = settingsDir();
    writeSettings(dir, "{corrupt", NOW + 60_000);
    const probe = probeHostSettings({ env: {}, dirs: [dir], spawnMs: NOW });
    expect(probe.notices).toHaveLength(1);
    expect(probe.notices[0]).toMatch(/Restart the MCP server/);
  });

  it("names the stale client id when the pane value is readable", () => {
    const dir = settingsDir();
    writeSettings(
      dir,
      { isEnabled: true, userConfig: { microsoft_client_id: "cid-new" } },
      NOW + 60_000,
    );
    const probe = probeHostSettings({
      env: { MESSAGEOPERATOR_MS_CLIENT_ID: "cid-old" },
      dirs: [dir],
      spawnMs: NOW,
    });
    expect(probe.staleClientId).toBe(true);
    expect(probe.paneClientId).toBe("cid-new");
    expect(probe.notices).toHaveLength(1);
    expect(probe.notices[0]).toContain("…id-new");
    expect(probe.notices[0]).toContain("…id-old");
    expect(probe.notices[0]).toMatch(/Restart the MCP server/);
  });

  it("detects a pane client id added while the server ran without one", () => {
    const dir = settingsDir();
    writeSettings(
      dir,
      { userConfig: { microsoft_client_id: "cid-new" } },
      NOW + 60_000,
    );
    const probe = probeHostSettings({ env: {}, dirs: [dir], spawnMs: NOW });
    expect(probe.staleClientId).toBe(true);
    expect(probe.notices[0]).toContain("(not set)");
  });

  it("suppresses the warning when the changed values already match this process", () => {
    const dir = settingsDir();
    writeSettings(
      dir,
      {
        isEnabled: true,
        userConfig: { microsoft_client_id: "cid", dry_run: true },
      },
      NOW + 60_000, // e.g. an enable/disable toggle bumped the mtime
    );
    const probe = probeHostSettings({
      env: {
        MESSAGEOPERATOR_MS_CLIENT_ID: "cid",
        MESSAGEOPERATOR_DRY_RUN: "true",
      },
      dirs: [dir],
      spawnMs: NOW,
    });
    expect(probe.changedSinceSpawn).toBe(true);
    expect(probe.staleClientId).toBe(false);
    expect(probe.notices).toEqual([]);
  });

  it("flags a non-client-id pane change by its setting name", () => {
    const dir = settingsDir();
    writeSettings(dir, { userConfig: { dry_run: false } }, NOW + 60_000);
    const probe = probeHostSettings({
      env: { MESSAGEOPERATOR_DRY_RUN: "true" },
      dirs: [dir],
      spawnMs: NOW,
    });
    expect(probe.staleClientId).toBe(false);
    expect(probe.notices).toHaveLength(1);
    expect(probe.notices[0]).toContain("'dry_run'");
  });
});

describe("recordEnvSnapshot", () => {
  function snapshotPath(): string {
    return path.join(tmpHome(), "env-snapshot.json");
  }

  it("writes a baseline silently on first run, then stays quiet while unchanged", () => {
    const file = snapshotPath();
    const env = { MESSAGEOPERATOR_MS_CLIENT_ID: "cid-old" };
    expect(recordEnvSnapshot(file, env)).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
    expect(recordEnvSnapshot(file, env)).toEqual([]);
  });

  it("announces a changed client id across restarts, masked", () => {
    const file = snapshotPath();
    recordEnvSnapshot(file, { MESSAGEOPERATOR_MS_CLIENT_ID: "cid-old" });
    const changes = recordEnvSnapshot(file, {
      MESSAGEOPERATOR_MS_CLIENT_ID: "cid-new",
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("MESSAGEOPERATOR_MS_CLIENT_ID");
    expect(changes[0]).toContain("…id-new");
    expect(changes[0]).toContain("…id-old");
    expect(changes[0]).not.toContain("cid-new"); // masked, not verbatim
    // the new value becomes the baseline
    expect(
      recordEnvSnapshot(file, { MESSAGEOPERATOR_MS_CLIENT_ID: "cid-new" }),
    ).toEqual([]);
  });

  it("reports cleared and non-secret values plainly", () => {
    const file = snapshotPath();
    recordEnvSnapshot(file, {
      MESSAGEOPERATOR_MS_CLIENT_ID: "cid-old",
      MESSAGEOPERATOR_DRY_RUN: "true",
    });
    const changes = recordEnvSnapshot(file, {
      MESSAGEOPERATOR_DRY_RUN: "false",
    });
    expect(changes).toHaveLength(2);
    expect(changes.join("\n")).toContain("(not set)");
    expect(changes.join("\n")).toContain(
      "MESSAGEOPERATOR_DRY_RUN is now false (was true)",
    );
  });

  it("treats unresolved ${...} templates as unset, like the config merge does", () => {
    const file = snapshotPath();
    recordEnvSnapshot(file, {
      MESSAGEOPERATOR_MS_CLIENT_ID: "${user_config.microsoft_client_id}",
    });
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(data.MESSAGEOPERATOR_MS_CLIENT_ID).toBe("");
  });
});
