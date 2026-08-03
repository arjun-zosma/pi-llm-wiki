import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ensureVaultStructure,
  getVaultPaths,
  exec as runCommand,
} from "../extensions/llm-wiki/lib/utils.js";
import { createExecApi } from "../mcp/exec.js";
import { captureSourceOperation } from "../mcp/operations.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("returns stdout, stderr, exit code, timeout, and abort state", async () => {
  const api = createExecApi();
  const success = await api.exec(process.execPath, ["-e", "console.log('ok')"]);
  expect(success).toMatchObject({ stdout: "ok\n", code: 0, killed: false });
  const failure = await api.exec(process.execPath, [
    "-e",
    "process.stderr.write('bad');process.exit(7)",
  ]);
  expect(failure).toMatchObject({ stderr: "bad", code: 7, killed: false });
  const timedOut = await api.exec(process.execPath, ["-e", "setTimeout(()=>{}, 1000)"], {
    timeout: 10,
  });
  expect(timedOut.killed).toBe(true);
  const started = Date.now();
  const stubborn = await api.exec(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>{},5000)"],
    { timeout: 10 },
  );
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(stubborn).toMatchObject({ killed: true });
  expect(stubborn.code).not.toBe(0);

  const controller = new AbortController();
  const aborted = api.exec(process.execPath, ["-e", "setTimeout(()=>{}, 1000)"], {
    signal: controller.signal,
  });
  controller.abort();
  await expect(aborted).resolves.toMatchObject({ killed: true });
});

it("kills descendant processes when a command times out", async () => {
  const root = join(import.meta.dirname, "..", "tmp", `mcp-tree-${Date.now()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const marker = join(root, "child.pid");
  const script = [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setTimeout(()=>{},5000)\"],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid))",
    "setTimeout(()=>{},5000)",
  ].join(";");
  const result = await createExecApi().exec(process.execPath, ["-e", script, marker], {
    timeout: 100,
  });
  expect(result, JSON.stringify(result)).toMatchObject({ killed: true });
  const childPid = Number(readFileSync(marker, "utf8"));
  let alive = true;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      alive = false;
      break;
    }
  }
  expect(alive).toBe(false);
});

it("does not defer process-group signals after the command settles", async () => {
  if (process.platform === "win32") return;
  const originalKill = process.kill.bind(process);
  const killSpy = vi
    .spyOn(process, "kill")
    .mockImplementation((pid, signal) => originalKill(pid, signal));
  try {
    const result = await createExecApi().exec(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>process.exit(0));setTimeout(()=>{},5000)"],
      { timeout: 10 },
    );
    expect(result.killed).toBe(true);
    const forceSignals = () => killSpy.mock.calls.filter(([, signal]) => signal === "SIGKILL");
    const settledSignals = forceSignals();
    expect(settledSignals.some(([pid]) => pid < 0)).toBe(true);
    expect(settledSignals.some(([pid]) => pid > 0)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(forceSignals()).toHaveLength(settledSignals.length);
  } finally {
    killSpy.mockRestore();
  }
});

it.each(["stdout", "stderr"] as const)(
  "bounds captured %s at a complete UTF-8 code point",
  async (stream) => {
    const script =
      stream === "stdout"
        ? "process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(16*1024*1024-1)+'€',()=>setTimeout(()=>process.stdout.write('A'),10));setTimeout(()=>{},5000)"
        : "process.on('SIGTERM',()=>{});process.stderr.write('x'.repeat(16*1024*1024-1)+'€',()=>setTimeout(()=>process.stderr.write('A'),10));setTimeout(()=>{},5000)";
    const result = await createExecApi().exec(process.execPath, ["-e", script], { timeout: 5_000 });
    expect(result).toMatchObject({ killed: true, code: 1 });
    expect(Buffer.byteLength(result[stream])).toBe(16 * 1024 * 1024 - 1);
  },
);

it("rejects failed commands and preserves local originals without shell copy", async () => {
  await expect(
    runCommand(createExecApi(), process.execPath, ["-e", "process.exit(7)"]),
  ).rejects.toThrow("Command failed");

  const root = join(import.meta.dirname, "..", "tmp", `mcp-file-failure-${Date.now()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ knowledge_format: "legacy" }));
  const input = join(root, "input.txt");
  writeFileSync(input, "MCP file body");
  const failingExec = {
    exec: async () => ({ stdout: "", stderr: "copy failed", code: 7, killed: false }),
  };
  const result = await captureSourceOperation(paths, { filePath: input }, failingExec as never);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    readFileSync(join(paths.rawSources, result.sourceId, "original", "input.txt"), "utf8"),
  ).toBe("MCP file body");
});

it("captures local files with a preserved original and current registry", async () => {
  const root = join(import.meta.dirname, "..", "tmp", `mcp-file-${Date.now()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ knowledge_format: "legacy" }));
  const input = join(root, "input.txt");
  writeFileSync(input, "MCP file body");
  const result = await captureSourceOperation(paths, { filePath: input }, createExecApi());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(existsSync(join(paths.rawSources, result.sourceId, "original", "input.txt"))).toBe(true);
  const registry = JSON.parse(readFileSync(join(paths.meta, "registry.json"), "utf8"));
  expect(registry.pages[`sources/${result.sourceId}`]).toBeDefined();
});

it("captures a local HTTP page through the production MCP runner", async () => {
  const server = createServer((_request, response) => {
    response.end("<html><title>Local</title><body><h1>Captured</h1><p>HTTP body</p></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const root = join(import.meta.dirname, "..", "tmp", `mcp-url-${Date.now()}`);
    roots.push(root);
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ knowledge_format: "legacy" }),
    );
    const result = await captureSourceOperation(
      paths,
      { url: `http://127.0.0.1:${address.port}/source` },
      createExecApi(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(paths.rawSources, result.sourceId, "extracted.md"), "utf8")).toContain(
      "HTTP body",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
