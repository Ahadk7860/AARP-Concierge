// The `npm run e2e` entry point.
//
// A separate file rather than an `if (process.argv[1] === …)` guard inside `run.ts`,
// because that guard is how the first version of this exited zero having executed
// nothing: under `vite-node`, `process.argv[1]` is the runner, not the module. A command
// that reports success without doing any work is the precise failure `gate.sh` exists to
// catch, and it is not a thing to leave a clever guard in charge of.
//
// A file whose only job is to run is unambiguous. `run.ts` stays importable by tests
// with no side effects at all.

import { closePool } from "../../db/src/index.js";
import { runEndToEnd } from "./run.js";

try {
  const result = await runEndToEnd();
  process.stdout.write(`\nartifacts: ${result.artifactDir}\n`);
  process.stdout.write(`sent: ${result.sent}  card: ${result.cardUrl ?? "none"}\n`);
  if (result.sent === 0) {
    process.stderr.write("the pipe ran but nothing was sent\n");
    process.exitCode = 1;
  }
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await closePool();
}
