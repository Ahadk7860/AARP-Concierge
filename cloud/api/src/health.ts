import type { FastifyInstance } from "fastify";

/**
 * The process owns readiness; route code should not need to know whether the
 * channel or database is real, injected, or in the middle of shutting down.
 */
export type RuntimeStatus = {
  live(): boolean | Promise<boolean>;
  ready(): boolean | Promise<boolean>;
};

const standaloneStatus: RuntimeStatus = {
  live: () => true,
  ready: () => true,
};

export function registerHealthRoutes(
  app: FastifyInstance,
  status: RuntimeStatus = standaloneStatus,
): void {
  app.get("/healthz", async (_request, reply) => {
    const live = await status.live();
    return reply.code(live ? 200 : 503).send({ status: live ? "ok" : "unavailable" });
  });

  app.get("/readyz", async (_request, reply) => {
    const ready = await status.ready();
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unready" });
  });
}
