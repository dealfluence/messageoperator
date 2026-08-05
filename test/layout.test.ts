import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { JailError, Layout } from "../src/layout.js";
import { makeLayout, tmpHome } from "./helpers.js";

describe("path jail", () => {
  it("resolves room-relative paths inside the room", () => {
    const layout = makeLayout();
    const p = layout.jail("accounts");
    // jail() resolves symlinks (see other cases below), so compare against the
    // realpath-resolved room — on macOS os.tmpdir() is /var → /private/var.
    expect(p).toBe(path.join(fs.realpathSync(layout.room), "accounts"));
  });

  it("accepts the room root itself", () => {
    const layout = makeLayout();
    expect(layout.jail(".")).toBe(fs.realpathSync(layout.room));
  });

  it("rejects relative escape to the broker directory", () => {
    const layout = makeLayout();
    expect(() => layout.jail("../broker/credentials")).toThrow(JailError);
    expect(() => layout.jail("../broker/ledger.jsonl")).toThrow(JailError);
    expect(() => layout.jail("accounts/../../broker")).toThrow(JailError);
  });

  it("rejects absolute paths outside the room", () => {
    const layout = makeLayout();
    expect(() => layout.jail(layout.credentials)).toThrow(JailError);
    expect(() => layout.jail(path.dirname(layout.home))).toThrow(JailError);
  });

  it("rejects symlinks that point outside the room", () => {
    const layout = makeLayout();
    const link = path.join(layout.room, "sneaky");
    try {
      fs.symlinkSync(layout.brokerDir, link, "junction");
    } catch {
      return; // symlink creation not permitted on this machine; jail still guards resolved paths
    }
    expect(() => layout.jail("sneaky")).toThrow(JailError);
    expect(() => layout.jail("sneaky/credentials")).toThrow(JailError);
  });

  it("allows nonexistent paths that would land inside the room", () => {
    const layout = makeLayout();
    const p = layout.jail("drafts/new-file.txt");
    expect(p.startsWith(fs.realpathSync(layout.room))).toBe(true);
  });
});

describe("room bootstrap", () => {
  it("installs the mail CLI, shim, and SKILL.md", () => {
    const layout = makeLayout();
    expect(fs.existsSync(path.join(layout.bin, "mail.py"))).toBe(true);
    expect(fs.existsSync(path.join(layout.bin, "mail"))).toBe(true);
    expect(fs.existsSync(path.join(layout.bin, "python3"))).toBe(true);
    expect(fs.existsSync(path.join(layout.skills, "SKILL.md"))).toBe(true);
    const shim = fs.readFileSync(path.join(layout.bin, "mail"), "utf-8");
    expect(shim.startsWith("#!/bin/sh\n")).toBe(true);
    expect(shim).toContain("mail.py");
    // the shim must never point at Node: the deployment machines only
    // guarantee a system Python (Claude Desktop's Node is not invokable)
    expect(shim).not.toContain("node");
    expect(shim).not.toContain("\r\n");

    if (process.platform === "win32") {
      expect(fs.existsSync(path.join(layout.bin, "mail.cmd"))).toBe(true);
      expect(fs.existsSync(path.join(layout.bin, "python3.cmd"))).toBe(true);
    }
  });

  it("removes a stale Node CLI draft from the bin", () => {
    const layout = makeLayout();
    fs.writeFileSync(path.join(layout.bin, "mail_cli.mjs"), "// stale");
    layout.ensureRoom();
    expect(fs.existsSync(path.join(layout.bin, "mail_cli.mjs"))).toBe(false);
  });

  it("creates the full Maildir tree per account", () => {
    const layout = makeLayout();
    layout.ensureAccount("a@example.com");
    for (const folder of ["INBOX", "Sent", "Drafts", "Outbox", "Archive"]) {
      for (const sub of ["cur", "new", "tmp"]) {
        expect(
          fs.existsSync(
            path.join(layout.accounts, "a@example.com", "mail", folder, sub),
          ),
        ).toBe(true);
      }
    }
    expect(layout.accountAddresses()).toEqual(["a@example.com"]);
  });

  it("refuses unsafe account directory names", () => {
    const layout = makeLayout();
    for (const bad of [
      "../../evil@x",
      "a/b@x.com",
      "a\\b@x.com",
      ".hidden@x.com",
      "no-at-sign",
    ]) {
      expect(() => layout.ensureAccount(bad)).toThrow(/unsafe account address/);
    }
  });

  it("rel() returns POSIX-style room-relative paths", () => {
    const layout = makeLayout();
    layout.ensureAccount("a@example.com");
    const p = path.join(
      layout.accounts,
      "a@example.com",
      "mail",
      "INBOX",
      "cur",
      "x.eml",
    );
    expect(layout.rel(p)).toBe("accounts/a@example.com/mail/INBOX/cur/x.eml");
  });

  describe("mail shim python resolution", () => {
    const originalPython = process.env.MESSAGEOPERATOR_PYTHON;

    afterEach(() => {
      if (originalPython === undefined)
        delete process.env.MESSAGEOPERATOR_PYTHON;
      else process.env.MESSAGEOPERATOR_PYTHON = originalPython;
    });

    it("MESSAGEOPERATOR_PYTHON override wins over PATH/registry lookup", () => {
      const fakePythonDir = tmpHome();
      const fakePython = path.join(fakePythonDir, "python3");
      fs.writeFileSync(fakePython, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(fakePython, 0o755);
      process.env.MESSAGEOPERATOR_PYTHON = fakePython;

      const layout = new Layout(tmpHome());
      layout.ensureRoom();
      const shim = fs.readFileSync(path.join(layout.bin, "mail"), "utf-8");
      // the shim is a /bin/sh script, so the python path is written POSIX-style
      // (forward slashes) even on Windows; compare against that form
      expect(shim).toContain(fs.realpathSync(fakePython).replace(/\\/g, "/"));
      // never the Electron helper running the test process itself, since
      // that binary cannot be re-invoked standalone under Claude Desktop
      expect(shim).not.toContain(process.execPath);
    });
  });
});
