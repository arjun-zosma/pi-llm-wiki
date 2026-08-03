#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

execFileSync(
  process.execPath,
  [join("node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.mcp.json"],
  {
    stdio: "inherit",
  },
);
mkdirSync("dist", { recursive: true });
writeFileSync(join("dist", "package.json"), '{"type":"module"}\n');
