import { execFile, spawn } from "node:child_process";
import type { ExecApi } from "../extensions/llm-wiki/lib/utils.js";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function createExecApi(): ExecApi {
  return {
    exec(command, args, options = {}) {
      return new Promise((resolve) => {
        let killed = false;
        let settled = false;
        let outputLimit = false;
        let forceTimer: NodeJS.Timeout | undefined;
        let stdout = "";
        let stderr = "";
        const child = spawn(command, args, {
          cwd: options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });

        const sendSignal = (signal: "SIGTERM" | "SIGKILL") => {
          if (process.platform === "win32" && child.pid) {
            execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
            return;
          }
          if (child.pid) {
            try {
              process.kill(-child.pid, signal);
              return;
            } catch {
              // Fall back to the direct child when process-group signalling fails.
            }
          }
          child.kill(signal);
        };
        const stop = () => {
          if (killed) return;
          killed = true;
          sendSignal("SIGTERM");
          forceTimer = setTimeout(() => {
            sendSignal("SIGKILL");
            forceTimer = undefined;
          }, 100);
        };
        const appendOutput = (current: string, chunk: string): string => {
          const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
          if (remaining <= 0) {
            outputLimit = true;
            stop();
            return current;
          }
          const bytes = Buffer.from(chunk);
          if (bytes.byteLength <= remaining) return current + chunk;
          outputLimit = true;
          stop();
          return current + bytes.subarray(0, remaining).toString();
        };

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout = appendOutput(stdout, chunk);
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr = appendOutput(stderr, chunk);
        });

        const timer = options.timeout ? setTimeout(stop, options.timeout) : undefined;
        const abort = () => stop();
        options.signal?.addEventListener("abort", abort, { once: true });

        const finish = (code: number) => {
          if (settled) return;
          cleanup();
          resolve({
            stdout,
            stderr,
            code: outputLimit ? 1 : killed && code === 0 ? 1 : code,
            killed,
          });
        };
        child.once("error", () => finish(1));
        child.once("close", (code) => finish(typeof code === "number" ? code : 1));

        function cleanup() {
          settled = true;
          if (timer) clearTimeout(timer);
          if (forceTimer && !killed) clearTimeout(forceTimer);
          options.signal?.removeEventListener("abort", abort);
        }

        if (options.signal?.aborted) stop();
      });
    },
  };
}
