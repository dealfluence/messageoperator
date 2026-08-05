/**
 * Global test setup.
 *
 * Every suite runs against the FILE secret backend. Without this, `npm test`
 * on a developer's macOS machine (or a macOS/Windows CI runner) would write
 * real items into the login Keychain / Credential Manager — process-global
 * state that no temp-dir isolation can undo, shared by every test at once.
 * The keychain and DPAPI adapters are covered instead by injecting a fake
 * command runner in test/secrets.test.ts, which works on any platform.
 *
 * Suites that construct a Broker directly (broker.test.ts, settings_page.test.ts)
 * never call makeLayout(), so this has to be process-wide rather than a helper.
 */
import { beforeEach } from "vitest";

import { BACKEND_ENV, clearSecretCache } from "../src/secrets.js";

process.env[BACKEND_ENV] = "file";

// reads are cached for 30s and master keys for the process lifetime; each test
// gets a fresh temp home, so carrying either across tests would be a lie
beforeEach(() => {
  clearSecretCache();
});
