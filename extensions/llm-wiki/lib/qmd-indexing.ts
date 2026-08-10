import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp as fsCp,
  rename as fsRename,
  rm as fsRm,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import type { KnowledgeDiagnostic } from "./knowledge-document.js";
import {
  hashQmdManifest,
  invalidateUnsafeQmdEntries,
  readQmdManifest,
  reconcileQmdMirror,
} from "./qmd-mirror.js";
import {
  QMD_PACKAGE_VERSION,
  type QmdResolvedModels,
  type QmdStoreFactory,
  resolveQmdModels,
} from "./qmd-store.js";
export type { QmdStoreFactory } from "./qmd-store.js";
import type { VaultPaths } from "./utils.js";

export type QmdComponent = "lexical" | "vectors";
export type QmdReindexScope = "changed" | "all";
export type QmdIndexState = "missing" | "ready" | "stale" | "recovering" | "error";

export interface QmdReindexOptions {
  scope: QmdReindexScope;
  components: QmdComponent[];
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: QmdIndexProgress) => void;
}

export interface QmdIndexProgress {
  stage: "mirror" | "copy" | "lexical" | "vectors" | "validate" | "swap";
  message: string;
  current?: number;
  total?: number;
}

export interface QmdIndexIssue {
  code: string;
  message: string;
  path?: string;
}

export interface QmdGeneratedStatus {
  state: QmdIndexState;
  vaultId?: string;
  qmdVersion: string;
  models: QmdResolvedModels;
  totalDocuments: number;
  canonicalDocuments: number;
  evidenceDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  manifestHash?: string;
  indexedManifestHash?: string;
  lastIndexedAt?: string;
  swapPhase?: QmdSwapPhase;
  issues: QmdIndexIssue[];
}

export interface QmdReindexResult {
  ok: boolean;
  vaultId?: string;
  scope: QmdReindexScope;
  components: QmdComponent[];
  documents: { indexed: number; updated: number; unchanged: number; removed: number };
  vectors: { generated: number; skipped: number; errors: number };
  elapsedMs: number;
  status: QmdGeneratedStatus;
  warnings: QmdIndexIssue[];
  errors: QmdIndexIssue[];
}

export type QmdSwapPhase = "prepared" | "previous-moved" | "current-promoted" | "validated";

interface QmdSwapJournal {
  version: 1;
  operationId: string;
  stagingName: string;
  phase: QmdSwapPhase;
  startedAt: string;
}

interface QmdIndexStateFile {
  version: 1;
  vaultId: string;
  qmdVersion: string;
  models: QmdResolvedModels;
  manifestHash: string;
  indexedAt: string;
  status: {
    totalDocuments: number;
    canonicalDocuments: number;
    evidenceDocuments: number;
    needsEmbedding: number;
    hasVectorIndex: boolean;
  };
}

export interface QmdIndexDeps {
  factory: QmdStoreFactory;
  fs?: {
    exists(path: string): Promise<boolean>;
    rename(from: string, to: string): Promise<void>;
    rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
    cp(
      from: string,
      to: string,
      options: { recursive: boolean; errorOnExist: boolean },
    ): Promise<void>;
  };
}

export interface QmdRecoverResult {
  ok: boolean;
  diagnostics: KnowledgeDiagnostic[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGING_NAME = /^staging-[0-9a-f-]{36}$/;

export class QmdIndexError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QmdIndexError";
  }
}

class QmdIndexCancelledError extends Error {
  constructor() {
    super("QMD indexing cancelled");
    this.name = "QmdIndexCancelledError";
  }
}

function diag(
  severity: KnowledgeDiagnostic["severity"],
  code: KnowledgeDiagnostic["code"] | (string & {}),
  path: string,
  message: string,
): KnowledgeDiagnostic {
  return { severity, code: code as KnowledgeDiagnostic["code"], path, message };
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
  await fsRename(temporary, path);
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function pathExists(p: string): Promise<boolean> {
  return new Promise((resolve) => (existsSync(p) ? resolve(true) : resolve(false)));
}

const realFs = {
  exists: pathExists,
  rename: fsRename,
  rm: fsRm as (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>,
  cp: fsCp as unknown as (
    from: string,
    to: string,
    options: { recursive: boolean; errorOnExist: boolean },
  ) => Promise<void>,
};

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// Per-vault lock
// ---------------------------------------------------------------------------

const lockDir = (paths: VaultPaths) => join(paths.qmd, "index.lock");

async function acquireIndexLock(paths: VaultPaths): Promise<void> {
  const dir = lockDir(paths);
  try {
    await mkdir(paths.qmd, { recursive: true });
    await mkdir(dir, { recursive: false });
    await writeFile(
      join(dir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        hostname: osHostname(),
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (await canRecoverLock(dir)) {
        await fsRm(dir, { recursive: true, force: true });
        return acquireIndexLock(paths);
      }
      throw new QmdIndexError("qmd_index_busy", `QMD index is locked by another process (${dir})`);
    }
    throw error;
  }
}

async function canRecoverLock(dir: string): Promise<boolean> {
  const owner = await readJsonFile<{ pid?: unknown; hostname?: unknown }>(join(dir, "owner.json"));
  if (!owner || typeof owner.pid !== "number" || typeof owner.hostname !== "string") return false;
  if (owner.hostname !== osHostname()) return false;
  return !processExists(owner.pid);
}

async function releaseIndexLock(paths: VaultPaths): Promise<void> {
  await fsRm(lockDir(paths), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// In-process per-vault queue (prevents same-extension races)
// ---------------------------------------------------------------------------

const queues = new Map<string, Promise<unknown>>();

async function enqueue<T>(root: string, work: () => Promise<T>): Promise<T> {
  const prev = queues.get(root) ?? Promise.resolve();
  const next = prev.then(work, work);
  queues.set(
    root,
    next.catch(() => undefined),
  );
  return next;
}

/** Test-only: drain/await queued work for a vault root. */
export function awaitQmdIndexQueue(root: string): Promise<unknown> {
  return queues.get(root) ?? Promise.resolve();
}

// ---------------------------------------------------------------------------
// Stable vault id backfill
// ---------------------------------------------------------------------------

export async function ensureVaultId(paths: VaultPaths): Promise<string> {
  const configPath = join(paths.dotWiki, "config.json");
  const config = (await readJsonFile<Record<string, unknown>>(configPath)) ?? {};
  if (typeof config.vault_id === "string") {
    if (!UUID.test(config.vault_id)) {
      throw new QmdIndexError(
        "config_invalid_vault_id",
        "config.json contains an invalid vault_id",
      );
    }
    return config.vault_id;
  }
  if (config.vault_id !== undefined) {
    throw new QmdIndexError(
      "config_invalid_vault_id",
      "config.json contains a non-string vault_id",
    );
  }
  const vaultId = randomUUID();
  await atomicWriteJson(configPath, { ...config, vault_id: vaultId });
  return vaultId;
}

// ---------------------------------------------------------------------------
// Swap journal helpers
// ---------------------------------------------------------------------------

async function readSwapJournal(paths: VaultPaths): Promise<QmdSwapJournal | null> {
  const journal = await readJsonFile<QmdSwapJournal>(paths.qmdSwap);
  if (!journal) return null;
  if (journal.version !== 1 || !STAGING_NAME.test(journal.stagingName ?? "")) return null;
  const phases: QmdSwapPhase[] = ["prepared", "previous-moved", "current-promoted", "validated"];
  if (!phases.includes(journal.phase)) return null;
  return journal;
}

/**
 * The document count a current store must report to be valid: the validated
 * manifest entry count when the manifest is readable, otherwise the recorded
 * count in the structurally valid current state file. Returns undefined when
 * neither is available (openability alone is then the only check).
 */
async function expectedDocumentCount(
  paths: VaultPaths,
  fs: NonNullable<QmdIndexDeps["fs"]>,
): Promise<number | undefined> {
  if (await fs.exists(paths.qmdManifest)) {
    try {
      const stateFile = await readJsonFile<QmdIndexStateFile>(
        join(paths.qmdCurrent, "index-state.json"),
      );
      const vaultId = stateFile?.vaultId;
      if (vaultId) {
        const manifest = await readQmdManifest(paths, vaultId);
        return Object.keys(manifest.entries).length;
      }
    } catch {
      // Malformed manifest — fall through to the state file expectation.
    }
  }
  const stateFile = await readJsonFile<QmdIndexStateFile>(
    join(paths.qmdCurrent, "index-state.json"),
  );
  return stateFile?.status?.totalDocuments;
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Recover an interrupted prior swap. Assumes the index lock is already held.
 * Handles both write-ahead journals (phase published before the destructive
 * rename it covers) and legacy post-operation journals (phase published after
 * the rename). Only cleans up generated state; malformed journals are left
 * untouched for inspection.
 */
async function recoverQmdIndexLocked(
  paths: VaultPaths,
  deps?: Partial<QmdIndexDeps>,
): Promise<QmdRecoverResult> {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const fs = deps?.fs ?? realFs;
  const factory: QmdStoreFactory =
    deps?.factory ?? (await import("./qmd-store.js")).openQmdIndexStore;

  const journal = await readSwapJournal(paths);
  if (!journal) {
    // Absent journal is fine. A malformed one is left untouched for inspection.
    if (await pathExists(paths.qmdSwap)) {
      diagnostics.push(
        diag(
          "warning",
          "qmd_swap_interrupted",
          paths.qmdSwap,
          "QMD swap journal is malformed; leaving state untouched for inspection",
        ),
      );
    }
    return { ok: true, diagnostics };
  }

  const staging = join(paths.qmd, journal.stagingName);
  const current = paths.qmdCurrent;
  const previous = join(paths.qmd, "previous");
  const currentExists = await fs.exists(join(current, "index.sqlite"));
  const previousExists = await fs.exists(previous);
  const stagingExists = await fs.exists(staging);

  const currentValid = () => validateCurrent(paths, factory, fs);

  switch (journal.phase) {
    case "prepared":
      // Write-ahead: nothing was renamed yet. Legacy post-op journal: current
      // may already have been moved to previous before the phase was written.
      if (!currentExists && previousExists) {
        await fs.rename(previous, current);
      }
      await fs.rm(staging, { recursive: true, force: true });
      break;
    case "previous-moved":
      if (currentExists && previousExists) {
        // Legacy: both renames happened before the phase was published.
        if (await currentValid()) {
          await fs.rm(previous, { recursive: true, force: true });
        } else {
          await fs.rm(current, { recursive: true, force: true });
          await fs.rename(previous, current);
        }
      } else if (!currentExists && previousExists) {
        // Crash after rename(current, previous): restore it.
        await fs.rename(previous, current);
      }
      // Else: crash before rename(current, previous) — keep current.
      await fs.rm(staging, { recursive: true, force: true });
      break;
    case "current-promoted":
      if (currentExists && previousExists) {
        // Crash after rename(staging, current) but before validated.
        if (await currentValid()) {
          await fs.rm(previous, { recursive: true, force: true });
        } else {
          await fs.rm(current, { recursive: true, force: true });
          await fs.rename(previous, current);
        }
      } else if (currentExists) {
        // No prior current: keep the promoted store only if it validates;
        // otherwise report missing rather than inventing a store.
        if (!(await currentValid())) {
          await fs.rm(current, { recursive: true, force: true });
        }
      } else if (previousExists) {
        // Crash before rename(staging, current): restore the previous current.
        await fs.rename(previous, current);
      }
      await fs.rm(staging, { recursive: true, force: true });
      break;
    case "validated":
      if (currentExists && previousExists) {
        if (await currentValid()) {
          await fs.rm(previous, { recursive: true, force: true });
        } else {
          await fs.rm(current, { recursive: true, force: true });
          await fs.rename(previous, current);
        }
      }
      break;
  }

  await fs.rm(paths.qmdSwap, { recursive: true, force: true });

  // A recovered validated current means the last indexing attempt actually
  // succeeded: clear the stale error artifact. Without a usable current, keep
  // it so status can still explain the failure.
  if (await currentValid()) {
    await fsRm(join(paths.qmd, "last-error.json"), { recursive: true, force: true });
  }
  return { ok: true, diagnostics };
}

async function validateCurrent(
  paths: VaultPaths,
  factory: QmdStoreFactory,
  fs: NonNullable<QmdIndexDeps["fs"]>,
): Promise<boolean> {
  if (!(await fs.exists(join(paths.qmdCurrent, "index.sqlite")))) return false;
  try {
    return await withStore(
      factory,
      { dbPath: join(paths.qmdCurrent, "index.sqlite"), documentsPath: paths.qmdDocuments },
      async (store) => {
        const status = await store.status();
        const expected = await expectedDocumentCount(paths, fs);
        return expected === undefined || status.totalDocuments === expected;
      },
    );
  } catch {
    return false;
  }
}

/** Public recovery entry point: acquires the lock and repairs any interrupted swap. */
export async function recoverQmdIndex(
  paths: VaultPaths,
  deps?: Partial<QmdIndexDeps>,
): Promise<QmdRecoverResult> {
  try {
    await acquireIndexLock(paths);
  } catch (error: unknown) {
    if (error instanceof QmdIndexError && error.code === "qmd_index_busy") {
      return {
        ok: false,
        diagnostics: [diag("error", "qmd_index_busy", lockDir(paths), error.message)],
      };
    }
    throw error;
  }
  try {
    return await recoverQmdIndexLocked(paths, deps);
  } finally {
    await releaseIndexLock(paths);
  }
}

// ---------------------------------------------------------------------------
// Reindex
// ---------------------------------------------------------------------------

async function withStore<T>(
  factory: QmdStoreFactory,
  input: { dbPath: string; documentsPath: string },
  work: (store: ReturnType<QmdStoreFactory> extends Promise<infer S> ? S : never) => Promise<T>,
): Promise<T> {
  const store = await factory(input);
  try {
    return await work(store);
  } finally {
    await store.close();
  }
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new QmdIndexCancelledError();
}

/**
 * Promote a validated staging store to current using a write-ahead journal.
 * Every destructive rename is preceded by a durable journal phase, so a crash
 * at any point leaves recovery enough intent to clean up or roll back.
 *
 * Ordering: prepared -> previous-moved (before rename current->previous)
 * -> current-promoted (before rename staging->current) -> validate promoted
 * current -> validated (only after count validation) -> cleanup.
 */
async function promoteStagingToCurrent(
  paths: VaultPaths,
  stagingName: string,
  factory: QmdStoreFactory,
  fs: NonNullable<QmdIndexDeps["fs"]>,
): Promise<void> {
  const staging = join(paths.qmd, stagingName);
  const current = paths.qmdCurrent;
  const previous = join(paths.qmd, "previous");

  const journal: QmdSwapJournal = {
    version: 1,
    operationId: randomUUID(),
    stagingName,
    phase: "prepared",
    startedAt: new Date().toISOString(),
  };
  await atomicWriteJson(paths.qmdSwap, journal);

  const currentExists = await fs.exists(join(current, "index.sqlite"));
  if (currentExists) {
    await fs.rm(previous, { recursive: true, force: true });
    journal.phase = "previous-moved";
    await atomicWriteJson(paths.qmdSwap, journal);
    await fs.rename(current, previous);
  }

  journal.phase = "current-promoted";
  await atomicWriteJson(paths.qmdSwap, journal);
  await fs.rename(staging, current);

  // Reopen and validate the promoted current: openable AND matching the
  // authoritative document count (manifest entry count, state file fallback).
  await withStore(
    factory,
    { dbPath: join(current, "index.sqlite"), documentsPath: paths.qmdDocuments },
    async (store) => {
      const status = await store.status();
      const expected = await expectedDocumentCount(paths, fs);
      if (expected !== undefined && status.totalDocuments !== expected) {
        throw new QmdIndexError(
          "qmd_index_error",
          `Promoted store validation failed: expected ${expected} documents, got ${status.totalDocuments}`,
        );
      }
    },
  );

  journal.phase = "validated";
  await atomicWriteJson(paths.qmdSwap, journal);
  await fs.rm(previous, { recursive: true, force: true });
  await fs.rm(paths.qmdSwap, { recursive: true, force: true });
  await fsRm(join(paths.qmd, "last-error.json"), { recursive: true, force: true });
}

/**
 * Reindex a vault's QMD store via copy-on-write staging and a journaled swap.
 * Acquires the cross-process lock and first recovers any interrupted swap.
 */
export async function reindexQmdVault(
  paths: VaultPaths,
  options: QmdReindexOptions,
  deps?: Partial<QmdIndexDeps>,
): Promise<QmdReindexResult> {
  const started = Date.now();
  const scope = options.scope;
  const components = [...new Set(options.components)];
  const force = options.force ?? false;
  const signal = options.signal;
  const onProgress = options.onProgress;
  const factory: QmdStoreFactory =
    deps?.factory ?? (await import("./qmd-store.js")).openQmdIndexStore;
  const fs = deps?.fs ?? realFs;

  const warnings: QmdIndexIssue[] = [];
  const errors: QmdIndexIssue[] = [];
  const documents = { indexed: 0, updated: 0, unchanged: 0, removed: 0 };
  const vectors = { generated: 0, skipped: 0, errors: 0 };

  return enqueue(paths.root, async () => {
    try {
      await acquireIndexLock(paths);
    } catch (error: unknown) {
      if (error instanceof QmdIndexError && error.code === "qmd_index_busy") {
        const status = await readQmdIndexStatus(paths);
        return {
          ok: false,
          scope,
          components,
          documents,
          vectors,
          elapsedMs: Date.now() - started,
          status,
          warnings,
          errors: [{ code: "qmd_index_busy", message: error.message }],
        };
      }
      throw error;
    }
    let vaultId: string | undefined;
    let manifestHash = "";
    try {
      checkCancelled(signal);
      // Always recover an interrupted prior swap first.
      const recovery = await recoverQmdIndexLocked(paths, deps);
      warnings.push(
        ...recovery.diagnostics.map((d) => ({ code: d.code, message: d.message, path: d.path })),
      );

      checkCancelled(signal);
      onProgress?.({ stage: "mirror", message: "Reconciling validated document mirror" });
      vaultId = await ensureVaultId(paths);
      const activeVaultId = vaultId;

      const mirror = await reconcileQmdMirror(paths, vaultId, scope);
      manifestHash = mirror.manifestHash;
      documents.indexed = mirror.counts.indexed;
      documents.updated = mirror.counts.updated;
      documents.unchanged = mirror.counts.unchanged;
      documents.removed = mirror.counts.removed;
      warnings.push(
        ...mirror.diagnostics.map((d) => ({ code: d.code, message: d.message, path: d.path })),
      );

      checkCancelled(signal);
      onProgress?.({ stage: "copy", message: "Preparing staging store" });

      const stagingName = `staging-${randomUUID()}`;
      const staging = join(paths.qmd, stagingName);
      await mkdir(staging, { recursive: true });

      // Copy the current store unless this is a forced lexical rebuild.
      const currentExists = await fs.exists(join(paths.qmdCurrent, "index.sqlite"));
      const emptyStaging = force && components.includes("lexical");
      if (currentExists && !emptyStaging) {
        await fs.cp(paths.qmdCurrent, staging, { recursive: true, errorOnExist: true });
      }

      const wantsLexical = components.includes("lexical");
      const wantsVectors = components.includes("vectors");
      if (wantsLexical || wantsVectors)
        onProgress?.({ stage: "lexical", message: "Updating lexical index" });

      let needsEmbedding = 0;
      let canonicalDocuments = 0;
      let evidenceDocuments = 0;
      let totalDocuments = 0;
      let hasVectorIndex = false;

      await withStore(
        factory,
        { dbPath: join(staging, "index.sqlite"), documentsPath: paths.qmdDocuments },
        async (store) => {
          if (wantsLexical || wantsVectors) {
            await store.update((progress) => {
              checkCancelled(signal);
              onProgress?.({
                stage: "lexical",
                message: `Indexing ${progress.collection}: ${progress.file}`,
                current: progress.current,
                total: progress.total,
              });
            });
          }
          if (wantsVectors) {
            onProgress?.({ stage: "vectors", message: "Embedding vectors" });
            const embedResult = await store.embed({
              force,
              onProgress: (progress) => {
                checkCancelled(signal);
                onProgress?.({
                  stage: "vectors",
                  message: "Embedding chunks",
                  current: progress.chunksEmbedded,
                  total: progress.totalChunks,
                });
              },
            });
            vectors.generated = embedResult.docsProcessed;
            vectors.errors = embedResult.errors;
          }
          const status = await store.status();
          checkCancelled(signal);
          totalDocuments = status.totalDocuments;
          needsEmbedding = status.needsEmbedding;
          canonicalDocuments = status.canonicalDocuments;
          evidenceDocuments = status.evidenceDocuments;
          hasVectorIndex = status.hasVectorIndex;
          if (wantsVectors) {
            vectors.skipped = Math.max(0, status.totalDocuments - vectors.generated);
          }
          const manifest = await readQmdManifest(paths, activeVaultId);
          if (status.totalDocuments !== Object.keys(manifest.entries).length) {
            throw new QmdIndexError(
              "qmd_index_error",
              `Indexed document count (${status.totalDocuments}) does not match manifest (${Object.keys(manifest.entries).length})`,
            );
          }
        },
      );

      checkCancelled(signal);
      const models = resolveQmdModels();
      const stateFile: QmdIndexStateFile = {
        version: 1,
        vaultId,
        qmdVersion: QMD_PACKAGE_VERSION,
        models,
        manifestHash,
        indexedAt: new Date().toISOString(),
        status: {
          totalDocuments,
          canonicalDocuments,
          evidenceDocuments,
          needsEmbedding,
          hasVectorIndex,
        },
      };
      await atomicWriteJson(join(staging, "index-state.json"), stateFile);

      // Reopen staging and validate before any rename.
      onProgress?.({ stage: "validate", message: "Validating staging store" });
      await withStore(
        factory,
        { dbPath: join(staging, "index.sqlite"), documentsPath: paths.qmdDocuments },
        async (store) => {
          const status = await store.status();
          checkCancelled(signal);
          if (status.totalDocuments !== totalDocuments) {
            throw new QmdIndexError("qmd_index_error", "Staging store validation failed");
          }
        },
      );

      // Journaled swap: every phase is durable intent published before the
      // destructive rename it covers; recovery uses journal + filesystem state.
      onProgress?.({ stage: "swap", message: "Promoting validated index" });
      await promoteStagingToCurrent(paths, stagingName, factory, fs);
      await fsRm(join(paths.qmd, "last-error.json"), { recursive: true, force: true });

      const status = await readQmdIndexStatus(paths);
      return {
        ok: true,
        vaultId,
        scope,
        components,
        documents,
        vectors,
        elapsedMs: Date.now() - started,
        status,
        warnings,
        errors,
      };
    } catch (error: unknown) {
      if (!(error instanceof QmdIndexCancelledError)) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({
          code: error instanceof QmdIndexError ? error.code : "qmd_index_error",
          message,
        });
        if (manifestHash) {
          await atomicWriteJson(join(paths.qmd, "last-error.json"), {
            code: error instanceof QmdIndexError ? error.code : "qmd_index_error",
            message: error instanceof Error ? error.message : String(error),
            manifestHash,
            at: new Date().toISOString(),
          });
        }
      }
      const status = await readQmdIndexStatus(paths);
      return {
        ok: false,
        vaultId,
        scope,
        components,
        documents,
        vectors,
        elapsedMs: Date.now() - started,
        status,
        warnings,
        errors,
      };
    } finally {
      await releaseIndexLock(paths);
    }
  });
}
/**
 * Safety-only path used after a metadata projection failure. Backfills/validates
 * the vault id, removes only unsafe mirror entries (missing or rejected pages),
 * and runs a lexical removal update only when entries were removed. Never adds
 * or updates valid mirror pages after a projection failure.
 */
export async function invalidateQmdAfterProjectionFailure(
  paths: VaultPaths,
  deps?: Partial<QmdIndexDeps>,
): Promise<void> {
  await enqueue(paths.root, async () => {
    try {
      await acquireIndexLock(paths);
    } catch {
      // Busy or transient — the safety pass is best-effort; status will show
      // the current state. Never remove a lock we do not own.
      return;
    }
    try {
      let vaultId: string;
      try {
        vaultId = await ensureVaultId(paths);
      } catch {
        return;
      }
      const result = await invalidateUnsafeQmdEntries(paths, vaultId);
      if (result.counts.removed === 0) return;

      const factory: QmdStoreFactory =
        deps?.factory ?? (await import("./qmd-store.js")).openQmdIndexStore;
      const fs = deps?.fs ?? realFs;

      // Lexical removal update: copy current to staging, update, validate, swap.
      const stagingName = `staging-${randomUUID()}`;
      const staging = join(paths.qmd, stagingName);
      await mkdir(staging, { recursive: true });
      if (await fs.exists(join(paths.qmdCurrent, "index.sqlite"))) {
        await fs.cp(paths.qmdCurrent, staging, { recursive: true, errorOnExist: true });
      }

      let totalDocuments = 0;
      let canonicalDocuments = 0;
      let evidenceDocuments = 0;
      let needsEmbedding = 0;
      let hasVectorIndex = false;
      await withStore(
        factory,
        { dbPath: join(staging, "index.sqlite"), documentsPath: paths.qmdDocuments },
        async (store) => {
          await store.update();
          const status = await store.status();
          totalDocuments = status.totalDocuments;
          canonicalDocuments = status.canonicalDocuments;
          evidenceDocuments = status.evidenceDocuments;
          needsEmbedding = status.needsEmbedding;
          hasVectorIndex = status.hasVectorIndex;
          const manifest = await readQmdManifest(paths, vaultId);
          if (status.totalDocuments !== Object.keys(manifest.entries).length) {
            throw new QmdIndexError(
              "qmd_index_error",
              `Indexed document count (${status.totalDocuments}) does not match manifest (${Object.keys(manifest.entries).length})`,
            );
          }
        },
      );

      const models = resolveQmdModels();
      await atomicWriteJson(join(staging, "index-state.json"), {
        version: 1,
        vaultId,
        qmdVersion: QMD_PACKAGE_VERSION,
        models,
        manifestHash: result.manifestHash,
        indexedAt: new Date().toISOString(),
        status: {
          totalDocuments,
          canonicalDocuments,
          evidenceDocuments,
          needsEmbedding,
          hasVectorIndex,
        },
      } as QmdIndexStateFile);

      // Journaled swap with write-ahead phases, shared with normal reindexing.
      await promoteStagingToCurrent(paths, stagingName, factory, fs);
    } catch {
      // Generated QMD state is repairable; leave current intact. Status shows stale/error.
    } finally {
      await releaseIndexLock(paths);
    }
  });
}

// ---------------------------------------------------------------------------
// Generated status
// ---------------------------------------------------------------------------

/**
 * Read generated QMD index status without opening any QMD store or loading a
 * model. Reads only manifest, current state, last-error, lock, and swap journal.
 */
export async function readQmdIndexStatus(paths: VaultPaths): Promise<QmdGeneratedStatus> {
  const models = resolveQmdModels();
  const issues: QmdIndexIssue[] = [];
  const vaultId = await readConfigVaultId(paths);
  const manifest = await readQmdManifestSafe(paths, vaultId);
  const manifestHash = manifest ? hashQmdManifest(manifest) : undefined;
  const stateFile = await readJsonFile<QmdIndexStateFile>(
    join(paths.qmdCurrent, "index-state.json"),
  );
  const lastError = await readJsonFile<{ code?: string; message?: string; manifestHash?: string }>(
    join(paths.qmd, "last-error.json"),
  );
  const journal = await readSwapJournal(paths);

  let state: QmdIndexState;
  let swapPhase: QmdSwapPhase | undefined;
  if (journal) {
    state = "recovering";
    swapPhase = journal.phase;
    issues.push({
      code: "qmd_swap_interrupted",
      message: "A QMD index swap was interrupted and is being recovered",
    });
  } else if (!stateFile) {
    state = "missing";
  } else if (stateFile.version !== 1 || typeof stateFile.vaultId !== "string") {
    state = "error";
    issues.push({ code: "qmd_index_error", message: "QMD index state file is malformed" });
  } else {
    const embedChanged = stateFile.models?.embed !== models.embed;
    const manifestChanged = manifestHash !== undefined && stateFile.manifestHash !== manifestHash;
    const versionChanged = stateFile.qmdVersion !== QMD_PACKAGE_VERSION;
    const vaultChanged = vaultId !== undefined && stateFile.vaultId !== vaultId;
    if (manifestChanged || versionChanged || vaultChanged || embedChanged || lastError) {
      state = "stale";
      if (lastError) {
        issues.push({
          code: "qmd_index_error",
          message: lastError.message ?? "Last QMD index attempt failed",
        });
      } else if (manifestChanged) {
        issues.push({
          code: "qmd_index_stale",
          message: "QMD index is stale relative to the document manifest",
        });
      } else if (embedChanged) {
        issues.push({
          code: "qmd_index_stale",
          message: "QMD embedding model changed; vectors are stale",
        });
      } else if (versionChanged) {
        issues.push({
          code: "qmd_index_stale",
          message: "QMD package version changed; index needs rebuild",
        });
      } else if (vaultChanged) {
        issues.push({ code: "qmd_index_stale", message: "QMD index vault identity changed" });
      }
    } else {
      state = "ready";
    }
  }

  return {
    state,
    vaultId: stateFile?.vaultId ?? vaultId,
    qmdVersion: QMD_PACKAGE_VERSION,
    models,
    totalDocuments: stateFile?.status?.totalDocuments ?? 0,
    canonicalDocuments: stateFile?.status?.canonicalDocuments ?? 0,
    evidenceDocuments: stateFile?.status?.evidenceDocuments ?? 0,
    needsEmbedding: stateFile?.status?.needsEmbedding ?? 0,
    hasVectorIndex: stateFile?.status?.hasVectorIndex ?? false,
    manifestHash,
    indexedManifestHash: stateFile?.manifestHash,
    lastIndexedAt: stateFile?.indexedAt,
    swapPhase,
    issues,
  };
}

async function readConfigVaultId(paths: VaultPaths): Promise<string | undefined> {
  const config = await readJsonFile<{ vault_id?: unknown }>(join(paths.dotWiki, "config.json"));
  if (config && typeof config.vault_id === "string" && UUID.test(config.vault_id)) {
    return config.vault_id;
  }
  return undefined;
}

async function readQmdManifestSafe(
  paths: VaultPaths,
  vaultId?: string,
): Promise<ReturnType<typeof readQmdManifest> extends Promise<infer T> ? T : never> {
  if (!vaultId) return null as never;
  try {
    return await readQmdManifest(paths, vaultId);
  } catch {
    return null as never;
  }
}
