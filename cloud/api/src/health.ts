import type { FastifyInstance } from "fastify";

export type ComponentState = "up" | "down" | "timeout";
export type ReadinessSnapshot = {
  ready: boolean;
  components: Record<string, ComponentState>;
};

/** Process-owned status, injected into the HTTP surface. */
export type RuntimeStatus = {
  live(): boolean | Promise<boolean>;
  ready(): ReadinessSnapshot | Promise<ReadinessSnapshot>;
};

export function registerHealthRoutes(app: FastifyInstance, status: RuntimeStatus): void {
  app.get("/healthz", async (_request, reply) => {
    const live = await status.live();
    return reply.code(live ? 200 : 503).send({ status: live ? "ok" : "unavailable" });
  });

  app.get("/readyz", async (_request, reply) => {
    const snapshot = await status.ready();
    return reply.code(snapshot.ready ? 200 : 503).send({
      status: snapshot.ready ? "ready" : "unready",
      components: snapshot.components,
    });
  });
}
