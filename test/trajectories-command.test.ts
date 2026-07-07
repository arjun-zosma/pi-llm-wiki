import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWikiTrajectoriesCommand } from "../extensions/llm-wiki/lib/trajectories-command.js";
import {
  loadTaskConfig,
  persistTaskModel,
  trajectoriesEnabled,
} from "../extensions/llm-wiki/lib/task-config.js";

/**
 * Issue #80: unit tests for the /wiki-trajectories command handler.
 *
 * The handler is registered as a pi command closure. These tests capture it
 * through a minimal fake pi and drive it with a fake ctx.
 */

interface NotifyCall {
  message: string;
  type: string;
}

type Handler = (args: string, ctx: Record<string, unknown>) => Promise<void>;

function captureHandler(): Handler {
  let handler: Handler | undefined;
  const fakePi = {
    registerCommand: (_name: string, descriptor: { handler: Handler }) => {
      handler = descriptor.handler;
    },
  };
  registerWikiTrajectoriesCommand(fakePi as never);
  if (!handler) throw new Error("handler was not registered");
  return handler;
}

function fakeCtx(
  overrides: Partial<{
    cwd: string;
    notify: (message: string, type: string) => void;
    reload: () => Promise<void>;
  }>,
): Record<string, unknown> {
  const notifications: NotifyCall[] = [];
  let reloadCalled = false;
  const ctx = {
    cwd: overrides.cwd ?? process.cwd(),
    ui: {
      notify: overrides.notify ?? ((message: string, type: string) => notifications.push({ message, type })),
    },
    reload: overrides.reload ?? (async () => { reloadCalled = true; }),
    // Expose for test assertions
    _notifications: notifications,
    _reloadCalled: () => reloadCalled,
  };
  return ctx;
}

describe("/wiki-trajectories command (issue #80)", () => {
  let tmpDir: string;
  let handler: Handler;

  beforeAll(() => {
    handler = captureHandler();
  });

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `trj-cmd-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("shows 'OFF' when no args and trajectories are disabled (default)", async () => {
    const notifications: NotifyCall[] = [];
    const ctx = fakeCtx({
      cwd: tmpDir,
      notify: (m, t) => notifications.push({ message: m, type: t }),
    });
    await handler("", ctx);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toMatch(/OFF/i);
    expect(notifications[0].type).toBe("info");
  });

  it("shows 'ON' when no args and trajectories are enabled", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { trajectories: true } }),
    );
    const notifications: NotifyCall[] = [];
    const ctx = fakeCtx({
      cwd: tmpDir,
      notify: (m, t) => notifications.push({ message: m, type: t }),
    });
    await handler("", ctx);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toMatch(/ON/i);
  });

  it("turns on with 'on' arg: persists true and reloads", async () => {
    let reloadCalled = false;
    const ctx = fakeCtx({
      cwd: tmpDir,
      reload: async () => { reloadCalled = true; },
    });
    await handler("on", ctx);
    expect(trajectoriesEnabled(loadTaskConfig(tmpDir))).toBe(true);
    expect(reloadCalled).toBe(true);
  });

  it("turns off with 'off' arg: persists false and reloads", async () => {
    // Start with it on
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { trajectories: true } }),
    );
    let reloadCalled = false;
    const ctx = fakeCtx({
      cwd: tmpDir,
      reload: async () => { reloadCalled = true; },
    });
    await handler("off", ctx);
    expect(trajectoriesEnabled(loadTaskConfig(tmpDir))).toBe(false);
    expect(reloadCalled).toBe(true);
  });

  it("does not persist or reload when already in the requested state", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { trajectories: true } }),
    );
    const notifications: NotifyCall[] = [];
    let reloadCalled = false;
    const ctx = fakeCtx({
      cwd: tmpDir,
      notify: (m, t) => notifications.push({ message: m, type: t }),
      reload: async () => { reloadCalled = true; },
    });
    await handler("on", ctx);
    expect(reloadCalled).toBe(false);
    expect(notifications.some((n) => /already/i.test(n.message))).toBe(true);
  });

  it("shows error for unrecognized arg, does not persist or reload", async () => {
    const notifications: NotifyCall[] = [];
    let reloadCalled = false;
    const ctx = fakeCtx({
      cwd: tmpDir,
      notify: (m, t) => notifications.push({ message: m, type: t }),
      reload: async () => { reloadCalled = true; },
    });
    await handler("banana", ctx);
    expect(trajectoriesEnabled(loadTaskConfig(tmpDir))).toBe(false);
    expect(reloadCalled).toBe(false);
    expect(notifications.some((n) => n.type === "error")).toBe(true);
  });

  it("preserves other llm-wiki settings when toggling on then off", async () => {
    // Set a task model first
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    persistTaskModel(tmpDir, { provider: "anthropic", id: "claude-haiku-4-5" });

    // Turn trajectories on
    const ctxOn = fakeCtx({ cwd: tmpDir });
    await handler("on", ctxOn);
    let cfg = loadTaskConfig(tmpDir);
    expect(cfg.trajectories).toBe(true);
    expect(cfg.taskModel).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });

    // Turn trajectories off — taskModel must survive
    const ctxOff = fakeCtx({ cwd: tmpDir });
    await handler("off", ctxOff);
    cfg = loadTaskConfig(tmpDir);
    expect(trajectoriesEnabled(cfg)).toBe(false); // key removed → false
    expect(cfg.taskModel).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  });

  it("accepts common synonyms for on and off", async () => {
    const synonyms = {
      on: ["true", "enable", "enabled", "yes", "1"],
      off: ["false", "disable", "disabled", "no", "0"],
    };

    for (const word of synonyms.on) {
      const d = join(import.meta.dirname, "..", "tmp", `trj-syn-${Date.now()}-${Math.random()}`);
      mkdirSync(d, { recursive: true });
      const ctx = fakeCtx({ cwd: d });
      await handler(word, ctx);
      expect(trajectoriesEnabled(loadTaskConfig(d))).toBe(true);
      rmSync(d, { recursive: true, force: true });
    }

    for (const word of synonyms.off) {
      const d = join(import.meta.dirname, "..", "tmp", `trj-syn-${Date.now()}-${Math.random()}`);
      mkdirSync(d, { recursive: true });
      const ctx = fakeCtx({ cwd: d });
      await handler(word, ctx);
      expect(trajectoriesEnabled(loadTaskConfig(d))).toBe(false);
      rmSync(d, { recursive: true, force: true });
    }
  });
});
