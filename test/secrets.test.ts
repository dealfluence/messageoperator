/**
 * The master-key backends are exercised with a FAKE command runner, so these
 * tests pin the real argv, stdin and fallback behavior on every platform —
 * including the Linux CI runner, which has neither `security` nor PowerShell —
 * without going near a real credential store. The real stores are covered by
 * test/secrets_os.test.ts, which runs only when MESSAGEOPERATOR_SECRET_IT=1.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BACKEND_ENV,
  MASTER_KEY_ACCOUNT,
  MasterKeyStore,
  SECRET_SERVICE,
  VOLUME_FILE,
  clearSecretCache,
  defaultBackend,
  deleteSecret,
  forgetMasterKey,
  getSecret,
  gmailSecretName,
  masterKey,
  readSealedFile,
  seal,
  secretStorageDescription,
  setSecret,
  unseal,
  writeSealedFile,
  type CommandRunner,
} from "../src/secrets.js";
import {
  MASTER_KEY_ACCOUNT as INGEST_ACCOUNT,
  SECRET_SERVICE as INGEST_SERVICE,
  VOLUME_FILE as INGEST_VOLUME,
  gmailSecretName as ingestGmailSecretName,
  readMasterKeySync,
  readSecretSync,
  readVolumeSync,
} from "../ingest/src/secrets.mjs";
import { makeLayout } from "./helpers.js";

interface Call {
  cmd: string;
  args: string[];
  stdin?: string;
}

/** A `security` stand-in: one in-memory keychain, interactive mode only. */
function fakeKeychain(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  const calls: Call[] = [];
  const run: CommandRunner = async (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin });
    const words = (stdin ?? "").trim().split(/\s+/);
    const flag = (f: string) => {
      const i = words.indexOf(f);
      return i >= 0 ? words[i + 1] : undefined;
    };
    const account = flag("-a") ?? "";
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string, code = 44) => ({ code, stdout: "", stderr });
    switch (words[0]) {
      case "find-generic-password": {
        const value = items.get(account);
        return value === undefined
          ? fail(
              "security: The specified item could not be found in the keychain.",
            )
          : ok(value + "\n");
      }
      case "add-generic-password":
        if (items.has(account) && !words.includes("-U")) {
          return fail("security: The specified item already exists.", 45);
        }
        items.set(account, flag("-w") ?? "");
        return ok();
      case "delete-generic-password":
        return items.delete(account) ? ok() : fail("could not be found");
      default:
        return fail(`unexpected: ${words.join(" ")}`);
    }
  };
  return { run, calls, items };
}

/**
 * A PowerShell stand-in. "DPAPI" is modeled as a marker plus the hex reversed —
 * reversible, but NOT a passthrough, so a test can still prove we persist what
 * Protect() returned rather than the value itself.
 */
function fakePowershell(opts: { fail?: boolean } = {}) {
  const calls: Call[] = [];
  const scramble = (hex: string) => [...hex].reverse().join("");
  const run: CommandRunner = async (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin });
    if (opts.fail) return { code: 1, stdout: "", stderr: "DPAPI said no" };
    const script = Buffer.from(args[3] ?? "", "base64").toString("utf16le");
    const payload = (stdin ?? "").trim();
    if (script.includes("ProtectedData]::Protect")) {
      return { code: 0, stdout: `dpapi${scramble(payload)}\r\n`, stderr: "" };
    }
    if (script.includes("Import-Clixml")) {
      const body = fs.readFileSync(payload, "utf-8").trim();
      return {
        code: 0,
        stdout: Buffer.from(body, "utf-8").toString("base64"),
        stderr: "",
      };
    }
    if (!payload.startsWith("dpapi")) {
      return { code: 1, stdout: "", stderr: "Key not valid for this state." };
    }
    return { code: 0, stdout: scramble(payload.slice(5)) + "\r\n", stderr: "" };
  };
  return { run, calls };
}

describe("backend selection", () => {
  it("is forced by the env var, and the test suite forces files", () => {
    expect(process.env[BACKEND_ENV]).toBe("file");
    expect(defaultBackend()).toBe("file");
    expect(defaultBackend({ [BACKEND_ENV]: "keychain" })).toBe("keychain");
    expect(defaultBackend({ [BACKEND_ENV]: "dpapi" })).toBe("dpapi");
  });

  it("falls back to the platform default when the override is junk", () => {
    const expected =
      process.platform === "darwin"
        ? "keychain"
        : process.platform === "win32"
          ? "dpapi"
          : "file";
    expect(defaultBackend({ [BACKEND_ENV]: "nonsense" })).toBe(expected);
    expect(defaultBackend({})).toBe(expected);
  });

  it("describes storage honestly per platform", () => {
    for (const kind of ["keychain", "dpapi", "file"] as const) {
      expect(secretStorageDescription(kind)).toContain("encrypted file");
    }
    expect(secretStorageDescription("keychain")).toContain("Keychain");
  });
});

describe("secrets volume", () => {
  it("stores every secret in one AES-256-GCM file, not in the OS store", async () => {
    const layout = makeLayout();
    await setSecret(layout, gmailSecretName("A@Gmail.com"), "abcdabcdabcdabcd");
    await setSecret(layout, gmailSecretName("b@gmail.com"), "ponmlkjihgfedcba");

    const volume = path.join(layout.credentials, VOLUME_FILE);
    const raw = fs.readFileSync(volume, "utf-8");
    expect(raw).not.toContain("abcdabcdabcdabcd");
    expect(await getSecret(layout, gmailSecretName("a@gmail.com"))).toBe(
      "abcdabcdabcdabcd",
    );
    expect(await getSecret(layout, gmailSecretName("b@gmail.com"))).toBe(
      "ponmlkjihgfedcba",
    );
    expect(await getSecret(layout, gmailSecretName("c@gmail.com"))).toBeNull();

    // one file for all secrets, one for the key — nothing per-address
    expect(fs.readdirSync(layout.credentials).sort()).toEqual([
      "master_key",
      VOLUME_FILE,
    ]);
  });

  it("uses the exact { iv, authTag, data } hex envelope", async () => {
    const layout = makeLayout();
    await setSecret(layout, "some.secret", "value");
    const env = JSON.parse(
      fs.readFileSync(path.join(layout.credentials, VOLUME_FILE), "utf-8"),
    );
    expect(Object.keys(env).sort()).toEqual(["authTag", "data", "iv"]);
    expect(env.iv).toMatch(/^[0-9a-f]{24}$/); // 12 bytes
    expect(env.authTag).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
    expect(env.data).toMatch(/^[0-9a-f]+$/);
  });

  it("uses a fresh IV on every write", async () => {
    const layout = makeLayout();
    const ivs = new Set<string>();
    for (let i = 0; i < 5; i++) {
      await setSecret(layout, "some.secret", `value-${i}`);
      const env = JSON.parse(
        fs.readFileSync(path.join(layout.credentials, VOLUME_FILE), "utf-8"),
      );
      ivs.add(env.iv);
    }
    expect(ivs.size).toBe(5);
  });

  it("keeps other secrets when one is deleted", async () => {
    const layout = makeLayout();
    await setSecret(layout, "keep.me", "kept");
    await setSecret(layout, "drop.me", "dropped");
    await deleteSecret(layout, "drop.me");
    expect(await getSecret(layout, "drop.me")).toBeNull();
    expect(await getSecret(layout, "keep.me")).toBe("kept");
  });

  it("refuses to store an empty value", async () => {
    const layout = makeLayout();
    await expect(setSecret(layout, "empty", "  ")).rejects.toThrow();
  });

  it("is 0600 on disk", async () => {
    const layout = makeLayout();
    await setSecret(layout, "some.secret", "value");
    if (process.platform !== "win32") {
      const mode = fs.statSync(path.join(layout.credentials, VOLUME_FILE)).mode;
      expect(mode & 0o777).toBe(0o600);
    }
  });

  it("sees a value written by another process (nothing is cached)", async () => {
    const layout = makeLayout();
    await setSecret(layout, "some.secret", "first");
    // simulate the set-gmail-password CLI writing the volume behind our back
    const other = makeLayout();
    fs.copyFileSync(
      path.join(layout.credentials, "master_key"),
      path.join(other.credentials, "master_key"),
    );
    await setSecret(other, "some.secret", "second");
    fs.copyFileSync(
      path.join(other.credentials, VOLUME_FILE),
      path.join(layout.credentials, VOLUME_FILE),
    );
    expect(await getSecret(layout, "some.secret")).toBe("second");
  });
});

describe("keychain backend (master key only)", () => {
  it("never puts the key in argv — the command goes in on stdin", async () => {
    const layout = makeLayout();
    const fake = fakeKeychain();
    const opts = { backend: "keychain" as const, run: fake.run };
    const key = await masterKey(layout, { ...opts, create: true });
    expect(key?.length).toBe(32);

    for (const call of fake.calls) {
      expect(call.cmd).toBe("security");
      expect(call.args).toEqual(["-i"]); // argv carries nothing else, ever
      expect(call.args.join(" ")).not.toContain(key!.toString("hex"));
    }
    const write = fake.calls.find((c) => c.stdin?.includes("add-generic"));
    expect(write?.stdin?.trim()).toBe(
      `add-generic-password -a ${MASTER_KEY_ACCOUNT} -s ${SECRET_SERVICE} ` +
        `-w ${key!.toString("hex")}`,
    );
    expect(fake.items.get(MASTER_KEY_ACCOUNT)).toBe(key!.toString("hex"));
  });

  it("stores the key as hex, so no tokenizer can mangle it", async () => {
    const layout = makeLayout();
    const fake = fakeKeychain();
    const key = await masterKey(layout, {
      backend: "keychain",
      run: fake.run,
      create: true,
    });
    expect(fake.items.get(MASTER_KEY_ACCOUNT)).toMatch(/^[0-9a-f]{64}$/);
    expect(key?.toString("hex")).toBe(fake.items.get(MASTER_KEY_ACCOUNT));
  });

  it("refuses commands that are not plain flags and hex", async () => {
    const layout = makeLayout();
    const store = new MasterKeyStore(layout, {
      backend: "keychain",
      run: fakeKeychain().run,
      account: "evil\nadd-generic-password -a other",
    });
    await expect(store.read()).rejects.toThrow(/unsafe command/);
  });

  it("reads back an existing key instead of minting a new one", async () => {
    const layout = makeLayout();
    const hex = "ab".repeat(32);
    const fake = fakeKeychain({ [MASTER_KEY_ACCOUNT]: hex });
    const key = await masterKey(layout, {
      backend: "keychain",
      run: fake.run,
      create: true,
    });
    expect(key?.toString("hex")).toBe(hex);
    expect(fake.calls.some((c) => c.stdin?.includes("add-generic"))).toBe(
      false,
    );
  });

  it("adopts a key file when a state home moves onto a Mac", async () => {
    const layout = makeLayout();
    await setSecret(layout, "some.secret", "written-on-linux");
    const keyFile = path.join(layout.credentials, "master_key");
    const hex = fs.readFileSync(keyFile, "utf-8").trim();
    forgetMasterKey(layout);

    const fake = fakeKeychain();
    const opts = { backend: "keychain" as const, run: fake.run };
    expect(await getSecret(layout, "some.secret", opts)).toBe(
      "written-on-linux",
    );
    expect(fake.items.get(MASTER_KEY_ACCOUNT)).toBe(hex);
    expect(fs.existsSync(keyFile)).toBe(false); // moved, not copied
  });
});

describe("dpapi backend (master key only)", () => {
  it("round-trips the key through a blob file, with nothing in argv", async () => {
    const layout = makeLayout();
    const fake = fakePowershell();
    const opts = { backend: "dpapi" as const, run: fake.run };
    const key = await masterKey(layout, { ...opts, create: true });
    expect(key?.length).toBe(32);

    const blob = path.join(layout.credentials, "master_key.dpapi");
    expect(fs.readFileSync(blob, "utf-8")).not.toContain(
      key!.toString("hex").slice(0, 16),
    );
    for (const call of fake.calls) {
      expect(call.args.slice(0, 3)).toEqual([
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
      ]);
      expect(call.args.join(" ")).not.toContain(key!.toString("hex"));
    }
    // and the key is usable across a cold start
    forgetMasterKey(layout);
    const again = await masterKey(layout, opts);
    expect(again?.toString("hex")).toBe(key!.toString("hex"));
  });

  it("invokes the ProtectedData API at CurrentUser scope", async () => {
    const layout = makeLayout();
    const fake = fakePowershell();
    await masterKey(layout, {
      backend: "dpapi",
      run: fake.run,
      create: true,
    });
    const scripts = fake.calls.map((c) =>
      Buffer.from(c.args[3] ?? "", "base64").toString("utf16le"),
    );
    expect(scripts.some((s) => s.includes("ProtectedData]::Protect"))).toBe(
      true,
    );
    for (const s of scripts) {
      expect(s).toContain("DataProtectionScope]::CurrentUser");
    }
  });

  it("reports no key rather than throwing when DPAPI fails", async () => {
    const layout = makeLayout();
    fs.writeFileSync(
      path.join(layout.credentials, "master_key.dpapi"),
      "dpapiff\n",
    );
    expect(
      await masterKey(layout, {
        backend: "dpapi",
        run: fakePowershell({ fail: true }).run,
      }),
    ).toBeNull();
  });
});

describe("master key safety", () => {
  it("is not generated on a read", async () => {
    const layout = makeLayout();
    expect(await masterKey(layout)).toBeNull();
    expect(fs.existsSync(path.join(layout.credentials, "master_key"))).toBe(
      false,
    );
  });

  it("refuses to mint a replacement when an unreadable key exists", async () => {
    const layout = makeLayout();
    // present but unreadable: find fails, and add without -U fails too
    const run: CommandRunner = async (_cmd, _args, stdin) =>
      stdin?.includes("add-generic-password") && !stdin.includes("-U")
        ? { code: 45, stdout: "", stderr: "The specified item already exists" }
        : { code: 44, stdout: "", stderr: "could not be found" };
    expect(
      await masterKey(layout, { backend: "keychain", run, create: true }),
    ).toBeNull();
  });

  it("refuses a key whose read-back does not match what we wrote", async () => {
    const layout = makeLayout();
    // a store that silently keeps someone else's key and exits 0 anyway —
    // exactly what a tool with unreliable exit codes would look like
    const run: CommandRunner = async (_cmd, _args, stdin) =>
      stdin?.includes("find-generic-password")
        ? { code: 0, stdout: "cd".repeat(32) + "\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    const store = new MasterKeyStore(layout, { backend: "keychain", run });
    expect(await store.createExclusive(Buffer.alloc(32, 1))).toBe(false);
  });

  it("leaves the ciphertext alone when the key is unavailable", async () => {
    const layout = makeLayout();
    const file = path.join(layout.credentials, "msal_token_cache.enc");
    await writeSealedFile(layout, file, "real-tokens");
    const before = fs.readFileSync(file);

    // a machine whose key only ever lived in the keychain, now locked
    fs.rmSync(path.join(layout.credentials, "master_key"), { force: true });
    forgetMasterKey(layout);
    const locked: CommandRunner = async () => ({
      code: 36,
      stdout: "",
      stderr: "User interaction is not allowed.",
    });
    const opts = { backend: "keychain" as const, run: locked };
    expect(await readSealedFile(layout, file, opts)).toBeNull();
    expect(await writeSealedFile(layout, file, "new-tokens", opts)).toBe(false);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe("sealed files", () => {
  it("round-trip through the master key", async () => {
    const layout = makeLayout();
    const file = path.join(layout.credentials, "msal_token_cache.enc");
    const payload = JSON.stringify({ RefreshToken: { a: "secret-token" } });

    expect(await writeSealedFile(layout, file, payload)).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).not.toContain("secret-token");
    expect(await readSealedFile(layout, file)).toBe(payload);
  });

  it("answers null for a missing file", async () => {
    const layout = makeLayout();
    expect(
      await readSealedFile(layout, path.join(layout.credentials, "nope.enc")),
    ).toBeNull();
  });

  it("rejects a tampered blob instead of returning garbage", async () => {
    const layout = makeLayout();
    const file = path.join(layout.credentials, "msal_token_cache.enc");
    await writeSealedFile(layout, file, "payload");
    const env = JSON.parse(fs.readFileSync(file, "utf-8"));
    env.data = env.data.slice(0, -2) + (env.data.endsWith("00") ? "11" : "00");
    fs.writeFileSync(file, JSON.stringify(env));
    expect(await readSealedFile(layout, file)).toBeNull();
  });

  it("rejects an empty or non-JSON file", async () => {
    const layout = makeLayout();
    const file = path.join(layout.credentials, "msal_token_cache.enc");
    await writeSealedFile(layout, file, "payload"); // makes the key exist
    for (const junk of ["", "   ", "not json", "{}"]) {
      fs.writeFileSync(file, junk);
      expect(await readSealedFile(layout, file)).toBeNull();
    }
  });

  it("will not decrypt a blob moved to another credential file", async () => {
    const layout = makeLayout();
    const key = await masterKey(layout, { create: true });
    if (!key) throw new Error("no master key");
    const blob = seal(key, "msal_token_cache.enc", "payload");
    expect(unseal(key, "msal_token_cache.enc", blob).toString()).toBe(
      "payload",
    );
    expect(() => unseal(key, "other.enc", blob)).toThrow();
  });

  it("still reads the binary envelope a pre-0.7 dev build wrote", async () => {
    const layout = makeLayout();
    const key = await masterKey(layout, { create: true });
    if (!key) throw new Error("no master key");
    // MAGIC | iv | tag | ciphertext, as the first implementation wrote it
    const crypto = await import("node:crypto");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("messageoperator:legacy.enc", "utf-8"));
    const body = Buffer.concat([cipher.update("old-payload"), cipher.final()]);
    const legacy = Buffer.concat([
      Buffer.from("MOSEC1"),
      iv,
      cipher.getAuthTag(),
      body,
    ]);
    const file = path.join(layout.credentials, "legacy.enc");
    fs.writeFileSync(file, legacy);
    expect(await readSealedFile(layout, file)).toBe("old-payload");
  });
});

describe("migration from pre-volume storage", () => {
  it("adopts a plaintext app password and deletes it", async () => {
    const layout = makeLayout();
    const name = gmailSecretName("a@gmail.com");
    const legacy = path.join(layout.credentials, name);
    fs.writeFileSync(legacy, "abcdabcdabcdabcd\n");

    expect(await getSecret(layout, name)).toBe("abcdabcdabcdabcd");
    expect(fs.existsSync(legacy)).toBe(false);
    // and it is in the volume now, not just returned once
    clearSecretCache();
    expect(await getSecret(layout, name)).toBe("abcdabcdabcdabcd");
  });

  it("adopts a per-address keychain item and removes it", async () => {
    const layout = makeLayout();
    const fake = fakeKeychain({ "a@gmail.com": "abcdabcdabcdabcd" });
    const opts = { backend: "keychain" as const, run: fake.run };
    const name = gmailSecretName("a@gmail.com");

    expect(await getSecret(layout, name, opts)).toBe("abcdabcdabcdabcd");
    expect(fake.items.has("a@gmail.com")).toBe(false); // no stale copy left
    expect(fake.items.has(MASTER_KEY_ACCOUNT)).toBe(true);
    clearSecretCache();
    expect(await getSecret(layout, name, opts)).toBe("abcdabcdabcdabcd");
  });

  it("adopts a per-address DPAPI blob and a clixml file", async () => {
    const layout = makeLayout();
    const opts = { backend: "dpapi" as const, run: fakePowershell().run };
    const blobName = gmailSecretName("blob@gmail.com");
    const xmlName = gmailSecretName("xml@gmail.com");
    fs.writeFileSync(
      path.join(layout.credentials, `${blobName}.dpapi`),
      // the fake's Protect() reverses the hex, so the fixture must too
      "dpapi" +
        [...Buffer.from("blobblobblobblob", "utf-8").toString("hex")]
          .reverse()
          .join(""),
    );
    fs.writeFileSync(
      path.join(layout.credentials, `${xmlName}.xml`),
      "xmlxmlxmlxmlxmlx\n",
    );

    expect(await getSecret(layout, blobName, opts)).toBe("blobblobblobblob");
    expect(await getSecret(layout, xmlName, opts)).toBe("xmlxmlxmlxmlxmlx");
    expect(
      fs.existsSync(path.join(layout.credentials, `${blobName}.dpapi`)),
    ).toBe(false);
    expect(fs.existsSync(path.join(layout.credentials, `${xmlName}.xml`))).toBe(
      false,
    );
  });

  it("keeps the legacy copy when it cannot be moved", async () => {
    const layout = makeLayout();
    const name = gmailSecretName("a@gmail.com");
    const legacy = path.join(layout.credentials, name);
    fs.writeFileSync(legacy, "abcdabcdabcdabcd\n");
    const locked: CommandRunner = async () => ({
      code: 36,
      stdout: "",
      stderr: "User interaction is not allowed.",
    });

    expect(
      await getSecret(layout, name, { backend: "keychain", run: locked }),
    ).toBe("abcdabcdabcdabcd");
    expect(fs.existsSync(legacy)).toBe(true); // losing it would lose the secret
  });

  it("deleting a secret also clears every pre-volume copy", async () => {
    const layout = makeLayout();
    const name = gmailSecretName("a@gmail.com");
    const fake = fakeKeychain({ "a@gmail.com": "abcdabcdabcdabcd" });
    const opts = { backend: "keychain" as const, run: fake.run };
    for (const suffix of ["", ".xml", ".dpapi"]) {
      fs.writeFileSync(path.join(layout.credentials, name + suffix), "x\n");
    }

    await deleteSecret(layout, name, opts);
    for (const suffix of ["", ".xml", ".dpapi"]) {
      expect(fs.existsSync(path.join(layout.credentials, name + suffix))).toBe(
        false,
      );
    }
    expect(fake.items.has("a@gmail.com")).toBe(false);
  });
});

describe("ingest mirror", () => {
  it("agrees with src/secrets.ts on names and locations", () => {
    expect(INGEST_SERVICE).toBe(SECRET_SERVICE);
    expect(INGEST_ACCOUNT).toBe(MASTER_KEY_ACCOUNT);
    expect(INGEST_VOLUME).toBe(VOLUME_FILE);
    expect(ingestGmailSecretName("A@Gmail.com")).toBe(
      gmailSecretName("A@Gmail.com"),
    );
  });

  it("decrypts the volume the broker wrote", async () => {
    const layout = makeLayout();
    await setSecret(layout, gmailSecretName("a@gmail.com"), "abcdabcdabcdabcd");
    await setSecret(layout, gmailSecretName("b@gmail.com"), "ponmlkjihgfedcba");

    const key = readMasterKeySync(layout.credentials, "file");
    expect(key?.length).toBe(32);
    expect(readVolumeSync(layout.credentials, key)).toEqual({
      [gmailSecretName("a@gmail.com")]: "abcdabcdabcdabcd",
      [gmailSecretName("b@gmail.com")]: "ponmlkjihgfedcba",
    });
    expect(
      readSecretSync(
        layout.credentials,
        ingestGmailSecretName("a@gmail.com"),
        "file",
      ),
    ).toBe("abcdabcdabcdabcd");
    expect(
      readSecretSync(layout.credentials, gmailSecretName("c@x.com"), "file"),
    ).toBeNull();
  });

  it("reports nothing rather than guessing when the key is wrong", async () => {
    const layout = makeLayout();
    await setSecret(layout, "some.secret", "value");
    expect(readVolumeSync(layout.credentials, Buffer.alloc(32, 9))).toEqual({});
  });

  it("still finds a secret an older build left in the open", () => {
    const layout = makeLayout();
    const name = gmailSecretName("legacy-fixture@example.invalid");
    fs.writeFileSync(path.join(layout.credentials, name), "abcdabcdabcdabcd\n");
    expect(readSecretSync(layout.credentials, name, "file")).toBe(
      "abcdabcdabcdabcd",
    );
  });
});
