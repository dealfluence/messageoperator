/**
 * The ONLY tests that touch a real OS credential store, so they are opt-in:
 * they run when MESSAGEOPERATOR_SECRET_IT=1, which CI sets on the macOS and
 * Windows runners. Everything else stubs the platform tools, which means their
 * exit codes, argv handling and output format are otherwise only ever checked
 * against assumptions — this file is what proves the assumptions.
 *
 * Safety: a unique throwaway service name per run (never "messageoperator"),
 * and the item is deleted in afterAll even when a test fails. Nothing here can
 * touch a real credential.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  MasterKeyStore,
  forgetMasterKey,
  getSecret,
  gmailSecretName,
  masterKey,
  readSealedFile,
  setSecret,
  writeSealedFile,
  type BackendKind,
} from "../src/secrets.js";
import { readSecretSync } from "../ingest/src/secrets.mjs";
import { makeLayout } from "./helpers.js";

const ENABLED = process.env.MESSAGEOPERATOR_SECRET_IT === "1";
const BACKEND: BackendKind | null =
  process.platform === "darwin"
    ? "keychain"
    : process.platform === "win32"
      ? "dpapi"
      : null;

/** Unique per run so a crashed earlier run cannot collide with this one. */
const SERVICE = `messageoperator-it-${process.pid}-${Math.floor(
  Math.random() * 1e6,
)}`;

interface Case {
  layout: ReturnType<typeof makeLayout>;
  opts: { backend: BackendKind; service: string; account: string };
}

const cases: Case[] = [];

/**
 * A fresh state home AND a fresh keychain account per test. A temp dir alone
 * is not isolation here: a keychain item is global per service+account, so
 * without a unique account name one test would see the previous test's key
 * (on macOS only — the DPAPI blob is per-directory, which is exactly the kind
 * of asymmetry that makes an OS test lie).
 */
function newCase(tag: string): Case {
  if (!BACKEND) throw new Error("unsupported platform");
  const c: Case = {
    layout: makeLayout(),
    opts: { backend: BACKEND, service: SERVICE, account: `master-key-${tag}` },
  };
  cases.push(c);
  return c;
}

afterAll(async () => {
  if (!ENABLED || !BACKEND) return;
  for (const c of cases) {
    try {
      await new MasterKeyStore(c.layout, c.opts).delete();
    } catch {
      /* best effort: never fail the run on cleanup */
    }
  }
});

describe.skipIf(!ENABLED || !BACKEND)(
  `real ${BACKEND ?? "n/a"} backend`,
  () => {
    it("creates a master key, then reads the same key back cold", async () => {
      const { layout, opts } = newCase("create");
      const created = await masterKey(layout, { ...opts, create: true });
      expect(created?.length).toBe(32);

      forgetMasterKey(layout); // drop the in-process cache: force a real read
      const read = await masterKey(layout, opts);
      expect(read?.toString("hex")).toBe(created?.toString("hex"));
    });

    it("refuses to replace an existing key (the no-clobber guarantee)", async () => {
      const { layout, opts } = newCase("noclobber");
      const first = await masterKey(layout, { ...opts, create: true });
      expect(first).not.toBeNull();

      const store = new MasterKeyStore(layout, opts);
      const replaced = await store.createExclusive(Buffer.alloc(32, 7));
      expect(replaced).toBe(false);
      // and the original is intact
      expect((await store.read())?.toString("hex")).toBe(
        first?.toString("hex"),
      );
    });

    it("reports no key at all before one is created", async () => {
      const { layout, opts } = newCase("empty");
      expect(await masterKey(layout, opts)).toBeNull();
    });

    it("stores and reads a secret end to end through the real store", async () => {
      const { layout, opts } = newCase("roundtrip");
      const name = gmailSecretName("it@example.invalid");
      await setSecret(layout, name, "abcdabcdabcdabcd", opts);

      forgetMasterKey(layout);
      expect(await getSecret(layout, name, opts)).toBe("abcdabcdabcdabcd");

      // the secret is in the volume, and the volume is not plaintext
      const volume = fs.readFileSync(
        path.join(layout.credentials, "secrets.json"),
        "utf-8",
      );
      expect(volume).not.toContain("abcdabcdabcdabcd");
      expect(JSON.parse(volume).iv).toMatch(/^[0-9a-f]{24}$/);
    });

    it("seals and unseals a token cache with the real key", async () => {
      const { layout, opts } = newCase("sealed");
      const file = path.join(layout.credentials, "msal_token_cache.enc");
      const payload = JSON.stringify({ RefreshToken: { a: "it-token" } });
      expect(await writeSealedFile(layout, file, payload, opts)).toBe(true);
      forgetMasterKey(layout);
      expect(await readSealedFile(layout, file, opts)).toBe(payload);
    });

    it("is readable by the synchronous ingest mirror", async () => {
      const { layout, opts } = newCase("mirror");
      const name = gmailSecretName("it-sync@example.invalid");
      await setSecret(layout, name, "ponmlkjihgfedcba", opts);
      // the mirror looks up the DEFAULT service, so only the file backend can
      // be checked cross-implementation here; the keychain/DPAPI key read is
      // covered by the assertions above plus the volume format being shared
      const key = await masterKey(layout, opts);
      if (!key) throw new Error("no master key");
      fs.writeFileSync(
        path.join(layout.credentials, "master_key"),
        key.toString("hex") + "\n",
      );
      expect(readSecretSync(layout.credentials, name, "file")).toBe(
        "ponmlkjihgfedcba",
      );
      fs.rmSync(path.join(layout.credentials, "master_key"), { force: true });
    });

    it("deletes the key so a wiped machine looks empty again", async () => {
      const { layout, opts } = newCase("delete");
      await masterKey(layout, { ...opts, create: true });
      await new MasterKeyStore(layout, opts).delete();
      forgetMasterKey(layout);
      expect(await masterKey(layout, opts)).toBeNull();
    });
  },
);
