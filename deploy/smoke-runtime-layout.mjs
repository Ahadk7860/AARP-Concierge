import { access } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const required = [
  "contracts/schema/digest.v1.json",
  "contracts/schema/voice_pack.v1.json",
  "cloud/db/migrations/001_identity.sql",
  "dist/cloud/api/src/main.js",
  "dist/cloud/card/src/main.js",
  "deploy/start.mjs",
];

await Promise.all(required.map((relative) => access(resolve(root, relative))));
process.stdout.write(`${JSON.stringify({ status: "ok", check: "runtime-layout" })}\n`);
