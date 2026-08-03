import { spawn, exec } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

// Hoisted mock to intercept destructured imports of spawn/exec in msgraph.ts
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn().mockImplementation(() => {
      // Return a dummy object with .unref() to prevent TypeError crashes
      return { unref: () => {} };
    }),
    exec: vi.fn().mockImplementation(() => {
      return {};
    }),
  };
});

import { openBrowser } from "../src/msgraph.js";

describe("openBrowser", () => {
  it("uses exec on win32 to correctly format and pass URLs with ampersands", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    try {
      const spawnSpy = vi.mocked(spawn);
      const execSpy = vi.mocked(exec);

      spawnSpy.mockClear();
      execSpy.mockClear();

      openBrowser("http://localhost:1234/?code=123&state=abc");

      // Verify exec was called instead of spawn
      expect(execSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy).not.toHaveBeenCalled();

      const cmdArg = execSpy.mock.calls[0]?.[0];
      expect(cmdArg).toBe(
        'start "" "http://localhost:1234/?code=123&state=abc"',
      );
      expect(cmdArg).not.toContain("^&"); // No caret escapes
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it("uses open on darwin platform", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    try {
      const spawnSpy = vi.mocked(spawn);
      const execSpy = vi.mocked(exec);

      spawnSpy.mockClear();
      execSpy.mockClear();

      openBrowser("http://localhost:1234/?code=123");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0]?.[0]).toBe("open");
      expect(spawnSpy.mock.calls[0]?.[1]).toEqual([
        "http://localhost:1234/?code=123",
      ]);
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});
