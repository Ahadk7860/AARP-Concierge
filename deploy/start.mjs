import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { processTargetFor } from "../dist/cloud/api/src/main.js";

export function targetFor(env = process.env) {
  const selected = processTargetFor(env);
  return {
    name: selected.name,
    file: fileURLToPath(new URL(`../${selected.relativeFile}`, import.meta.url)),
  };
}

export function runSelectedProcess(env = process.env) {
  const target = targetFor(env);
  const child = spawn(process.execPath, [target.file], { env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  child.once("exit", (code, signal) => {
    if (signal !== null) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  return child;
}

if (process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSelectedProcess();
}
