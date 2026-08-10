#!/usr/bin/env node

/**
 * Mirror `prompts/*.md` into `commands/*.md`.
 *
 * pi discovers slash-command templates through the `pi.prompts` manifest key,
 * which points at `prompts/`. oh-my-pi has no such manifest key: its
 * `omp-plugins` discovery provider scans an extension package's *conventional*
 * sibling directories, where `prompts/` becomes the `/prompts:` menu and only
 * `commands/` becomes real `/name` slash commands.
 *
 * `prompts/` stays the single source of truth (it is the upstream layout);
 * `commands/` is generated from it and committed so both the npm tarball and a
 * plain `git clone` expose `/wiki-*` under either host.
 *
 * Run `node scripts/build-commands.js` after editing anything in `prompts/`.
 * `test/package-structure.test.ts` fails when the two drift.
 */

const { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const PROMPTS_DIR = "prompts";
const COMMANDS_DIR = "commands";

const sources = readdirSync(PROMPTS_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort();

rmSync(COMMANDS_DIR, { recursive: true, force: true });
mkdirSync(COMMANDS_DIR, { recursive: true });

for (const name of sources) {
  writeFileSync(join(COMMANDS_DIR, name), readFileSync(join(PROMPTS_DIR, name)));
}

console.log(`build-commands: mirrored ${sources.length} template(s) into ${COMMANDS_DIR}/`);
