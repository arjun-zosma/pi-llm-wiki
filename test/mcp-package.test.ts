import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { readFile, rootDir } from "./helpers.js";

let root: string;

beforeAll(() => {
  execFileSync("pnpm", ["build:mcp"], { cwd: rootDir, stdio: "ignore" });
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

type JsonRpcMessage = Record<string, unknown>;

function frame(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function nextMessage(child: ChildProcessWithoutNullStreams): Promise<JsonRpcMessage> {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      child.stdout.off("data", onData);
      resolve(JSON.parse(line) as JsonRpcMessage);
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("close", () => reject(new Error("MCP server exited before response")));
  });
}

async function request(
  child: ChildProcessWithoutNullStreams,
  message: JsonRpcMessage,
): Promise<JsonRpcMessage> {
  child.stdin.write(frame(message));
  return nextMessage(child);
}

it("starts the published MCP command, exposes five tools, and invokes operations", async () => {
  const pkg = JSON.parse(readFile(join(rootDir, "package.json"))) as {
    pi: { mcpservers: Record<string, string> };
  };
  const command = pkg.pi.mcpservers["llm-wiki"];
  expect(command).toBe("node ./dist/mcp/index.js");

  root = mkdtempSync(join(rootDir, "tmp", "mcp-package-"));
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ knowledge_format: "legacy" }));

  const [runtime, script] = command.split(" ");
  const child = spawn(runtime, [script], {
    cwd: rootDir,
    env: { ...process.env, WIKI_ROOT: root },
    stdio: "pipe",
  });
  child.stderr.resume();

  try {
    const initialized = await request(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "package-test", version: "1.0.0" },
      },
    });
    expect(initialized.result).toBeDefined();
    child.stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));

    const listed = await request(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "wiki_capture_source",
      "wiki_recall",
      "wiki_retro",
      "wiki_search",
      "wiki_status",
    ]);

    const status = await request(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "wiki_status", arguments: {} },
    });
    expect((status.result as { isError?: boolean }).isError).not.toBe(true);

    const retro = await request(child, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "wiki_retro",
        arguments: { slug: "packaged-insight", title: "Packaged Insight", body: "Body." },
      },
    });
    expect((retro.result as { isError?: boolean }).isError).not.toBe(true);
  } finally {
    child.stdin.end();
    if (!child.killed) child.kill();
  }
}, 30_000);
