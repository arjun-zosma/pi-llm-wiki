import { execFile } from "node:child_process";
import type { ExecApi } from "../extensions/llm-wiki/lib/utils.js";

export function createExecApi(): ExecApi {
  return {
    exec(command, args, options = {}) {
      return new Promise((resolve) => {
        let killed = false;
        const child = execFile(
          command,
          args,
          {
            cwd: options.cwd,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            cleanup();
            resolve({
              stdout: String(stdout),
              stderr: String(stderr),
              code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
              killed,
            });
          },
        );

        const stop = () => {
          killed = true;
          child.kill("SIGTERM");
        };
        const timer = options.timeout ? setTimeout(stop, options.timeout) : undefined;
        const abort = () => stop();
        options.signal?.addEventListener("abort", abort, { once: true });

        function cleanup() {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        }

        if (options.signal?.aborted) stop();
      });
    },
  };
}
