// The `npm run card` entry point.
//
// A separate file rather than an `if (process.argv[1].endsWith(…))` guard inside
// `server.ts`, for the reason prompt 04 paid for: under `vite-node`, `process.argv[1]` is
// the runner and not the module, so the guard silently starts nothing and the process
// exits zero. A file whose only job is to run cannot do that.
//
// The guard in `server.ts` stays — `node dist/card/src/server.js` is still a valid way to
// start this — but nothing depends on it any more.

import { buildCardServer, CARD_PORT } from "./server.js";

const app = buildCardServer();
await app.listen({ port: CARD_PORT, host: "127.0.0.1" });
process.stdout.write(
  `${JSON.stringify({ level: "info", msg: "card renderer listening", port: CARD_PORT })}\n`,
);
