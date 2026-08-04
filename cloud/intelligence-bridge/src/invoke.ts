// The process boundary between the cloud and `boi_intel`.
//
// Track B built the intelligence in Python with its own CLIs. Track D built a brief
// composer that takes gists and drafts as injected arguments. Neither has ever seen the
// other's output. This file is the only place in the system where one calls the other,
// and it is deliberately the narrowest thing that can work: argv in, files out, exit
// code checked first.
//
// Shelling out to Python from Node is easy to get 90% right. The 10% is all here.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Repo root, derived from this file rather than the working directory. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/**
 * The interpreter.
 *
 * `.venv/bin/python` before `python3`, because `pyproject.toml` requires >= 3.11 and the
 * macOS system `python3` is 3.9 — a bridge that silently picked the system interpreter
 * would fail inside `boi_intel` on syntax rather than here on configuration.
 *
 * Returned as a value rather than resolved at import time so a test can point it at a
 * path that does not exist and watch this fail properly.
 */
export function pythonExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["BOI_PYTHON"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const venv = path.join(REPO_ROOT, ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

export type InvokeOptions = {
  /** Killed at this deadline. The child is killed, not merely abandoned. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

export type InvokeResult = {
  argv: string[];
  /** The child's pid, so a caller can prove the process group went with it. */
  pid: number | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The child was observed to exit. False only if the runtime lied to us. */
  reaped: boolean;
  durationMs: number;
};

/** Raised when the interpreter itself could not be started. Distinct from a crash. */
export class PythonUnavailableError extends Error {
  constructor(
    readonly executable: string,
    readonly cause_message: string,
  ) {
    super(
      `the intelligence bridge could not start Python at "${executable}": ${cause_message}. ` +
        `boi_intel is invoked as a subprocess; without an interpreter there are no gists ` +
        `and no drafts. Set BOI_PYTHON, or create .venv with the project's toolchain.`,
    );
    this.name = "PythonUnavailableError";
  }
}

export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Runs `python -m <module> …` and waits for it to actually be gone.
 *
 * Four traps, all of them load-bearing:
 *
 * 1. **A non-zero exit with valid JSON on stdout is still a failure.** Callers check
 *    `status` before they look at anything else, and this function never parses.
 * 2. **`stdout` is not the only thing `boi_intel` writes.** `draft.py` prints a
 *    `draft.produced` log line AND the bundle to the same stream; `gist.py` prints a
 *    human summary. So nothing here parses stdout — the callers read the `--out` file
 *    the module wrote, and stdout is kept only for diagnostics.
 * 3. **A timeout must kill the child**, not just reject the promise. An orphaned model
 *    call holds a Gemini quota slot and a file handle. The child is spawned
 *    `detached` so the whole process group goes, and this waits for `close` before it
 *    resolves — so "the child was reaped" is observed rather than assumed.
 * 4. **A missing interpreter is a distinct failure.** `spawn` reports it as an `error`
 *    event with no exit code, which is otherwise indistinguishable from a crash.
 */
export async function invokePython(
  module: string,
  args: readonly string[],
  options: InvokeOptions = {},
): Promise<InvokeResult> {
  return await spawnPython(["-m", module, ...args], options);
}

/**
 * `invokePython` with raw interpreter arguments instead of `-m <module>`.
 *
 * The same spawn, the same timeout, the same kill — `invokePython` is a thin wrapper.
 * Exported because the process-group kill cannot be proven without a child that itself
 * has a child, and `-m` can only reach modules that exist in `boi_intel`. A test that
 * asserts `SIGKILL` on a childless interpreter proves nothing about `kill(-pid)`.
 */
export async function spawnPython(
  argvTail: readonly string[],
  options: InvokeOptions = {},
): Promise<InvokeResult> {
  // MERGED, not `options.env` alone. `options.env` carries the per-call overrides the
  // bridge sets (`BOI_MODEL_PROVIDER`), and reading only that would mean an operator's
  // `BOI_PYTHON` was silently ignored while `pythonExecutable` reported honouring it.
  // The same merge is what the child receives below, so the interpreter this picks and
  // the environment it runs in cannot disagree.
  const executable = pythonExecutable({ ...process.env, ...options.env });
  const argv = [executable, ...argvTail];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();

  return await new Promise<InvokeResult>((resolve, reject) => {
    const child = spawn(executable, [...argvTail], {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...options.env, PYTHONPATH: path.join(REPO_ROOT, "intelligence") },
      // Its own process group, so a timeout kills the interpreter AND anything it
      // spawned rather than leaving a model call running against our quota.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // Bounded. A runaway child must not be able to exhaust this process's memory with
    // the very log output we are keeping only for diagnostics.
    const MAX_CAPTURE = 256 * 1024;
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGKILL");
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT" || err.code === "EACCES") {
        reject(new PythonUnavailableError(executable, err.message));
        return;
      }
      reject(err);
    });

    // `close`, not `exit`: `exit` fires when the process dies, `close` when its stdio
    // has also been drained. Resolving on `exit` truncates the diagnostics.
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        argv,
        pid: child.pid ?? null,
        status,
        signal,
        stdout,
        stderr,
        timedOut,
        // MEASURED, not asserted. This was the literal `true`, which made
        // `expect(result.reaped).toBe(true)` a test that could not fail — a regression
        // from `kill(-pid)` to `kill(pid)` would have passed it while leaving an orphaned
        // model call holding a quota slot. `kill(pid, 0)` throws ESRCH when the process
        // is genuinely gone, so this is a probe rather than a claim.
        reaped: isGone(child.pid),
        durationMs: Date.now() - started,
      });
    });
  });
}

/** Whether a pid is genuinely gone. `kill(pid, 0)` signals nothing and throws ESRCH. */
export function isGone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    // Negative pid is the process group — `detached: true` above made the child its
    // leader. Killing only `pid` would leave a model call running.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone. Nothing to do, and throwing here would mask the real outcome.
    }
  }
}

/** A one-line, content-free description of how an invocation failed. */
export function describeFailure(result: InvokeResult): string {
  if (result.timedOut) return `timed_out after ${result.durationMs}ms`;
  if (result.signal !== null) return `killed by ${result.signal}`;
  if (result.status !== 0) return `exit ${result.status}`;
  return "ok";
}

/**
 * The last line of stderr, for a log field.
 *
 * Bounded and last-line-only on purpose: a Python traceback's final line is the
 * exception, and the frames above it can contain a file path with a user id in it. This
 * is diagnostics, not a transcript.
 */
export function lastStderrLine(result: InvokeResult, max = 200): string {
  const lines = result.stderr.trimEnd().split("\n");
  return (lines[lines.length - 1] ?? "").slice(0, max);
}
