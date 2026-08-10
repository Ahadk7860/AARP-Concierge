// K-02 runtime composition: wires Spectrum stream → inbound router → retention worker
// into the existing H runtime. Returns health checks and cleanup functions that main.ts
// installs alongside its existing lifecycle.

import type { Channel, InboundMessage } from "../shared/src/index.js";
import type { Queryable } from "../db/src/pool.js";
import { getPool, type UserScope } from "../db/src/index.js";
import { PostgresPhase2PrivateRepository } from "../db/src/repository.js";
import { SpectrumStream, type SpectrumStreamPort, type SpectrumStreamCheckpoint } from "../channel/src/spectrum-stream.js";
import { InboundRouter, type InboundRouterOptions } from "../inbound/router.js";
import { EncryptedPrivateStore } from "../inbound/private-store.js";
import { HandleVault } from "../inbound/handle-vault.js";
import { TurnVault } from "../inbound/turn-vault.js";
import { TurnRetentionWorker, IntervalRetentionSchedule, scheduleTurnRetention, type RetentionLogEvent } from "../inbound/retention-worker.js";
import type { HandleVaultKeyProvider } from "../inbound/handle-vault.js";
import { adaptKeyProvider } from "./key-provider-adapter.js";
import { PostgresStreamCheckpoint } from "./checkpoint-adapter.js";
import {
  SpectrumEventDecoder,
  HandleUserResolver,
  AutoSetupUserCreator,
  SpectrumReplyDeliveryPort,
  DeterministicIntentAdapter,
  ClosedChatAdapter,
} from "./inbound-adapter.js";
import type { ChatSelectorProvider } from "../chat/src/selector.js";
import type { HandleEnvelopeKeyProvider } from "../api/src/main.js";
// Track H (v3/h-join): the v3 agent path, wired BESIDE ClosedChatAdapter rather than in
// place of it, selected below via BOI_AGENT_PATH_ENABLED (agentPathEnabledFromEnv). See
// cloud/agent/src/inbound-bridge.ts's file-level comment for the two known gaps this
// wiring carries (multi-bubble collapse, ChatReply v1 downgrade, no real AgentStore yet).
import { agentPathEnabledFromEnv } from "../agent/src/runtime.js";
import { AgentClosedChatBridge } from "../agent/src/inbound-bridge.js";
import { InMemoryAgentStore } from "../agent/src/ports.js";
import type { ClosedChatPort } from "../inbound/router.js";

export type Phase2Dependencies = {
  db: Queryable;
  user_id: string;
  streamPort: SpectrumStreamPort;
  channel: Channel;
  keyProvider: HandleEnvelopeKeyProvider;
  selectorProvider: ChatSelectorProvider;
};

export type Phase2Runtime = {
  health(): Promise<{
    stream: "up" | "down" | "degraded";
    retention: "up" | "down";
  }>;
  close(): Promise<void>;
};

export async function startPhase2Runtime(deps: Phase2Dependencies): Promise<Phase2Runtime> {
  const vaultKeyProvider = adaptKeyProvider(deps.keyProvider);
  const handleVault = new HandleVault({ keyProvider: vaultKeyProvider });
  const turnVault = new TurnVault({ keyProvider: vaultKeyProvider });
  // PostgresPhase2PrivateRepository currently requires a pg.Pool, not just Queryable.
  // This is a narrow casting bridge; the repository only calls .query() internally.
  const repository = new PostgresPhase2PrivateRepository(deps.db as import("pg").Pool);
  const privateStore = new EncryptedPrivateStore(repository, turnVault, handleVault);
  const checkpoint = new PostgresStreamCheckpoint(deps.db, deps.user_id);

  // The selector is created at the main.ts factory level — it already
  // reads liveModelConfigFromEnv() when configured, falling back to the
  // decline stub when no model key is present. compose-runtime uses whatever
  // it receives.
  // BOI_AGENT_PATH_ENABLED gates the v3 agent path; absent/any-other-value keeps the
  // proven-live closed-vocabulary path (runtime.ts's "fails closed" convention, §2/§6).
  // The agent path's AgentStore has no real backing until Track E's §4.1 tables merge —
  // see inbound-bridge.ts's third gap note — so this flag must stay unset in production
  // until then; it exists so the wiring is reachable and testable now.
  const chat: ClosedChatPort = agentPathEnabledFromEnv()
    ? new AgentClosedChatBridge({ store: new InMemoryAgentStore() })
    : new ClosedChatAdapter(deps.db, deps.selectorProvider);

  const router = new InboundRouter({
    decoder: new SpectrumEventDecoder(),
    users: new HandleUserResolver(deps.db),
    setupUser: new AutoSetupUserCreator(deps.db),
    deterministic: new DeterministicIntentAdapter(),
    chat,
    delivery: new SpectrumReplyDeliveryPort(deps.channel),
    privateStore,
  });

  const stream = new SpectrumStream({
    port: deps.streamPort,
    checkpoint,
    onEvent: async (event) => {
      try { await router.route(event); } catch (err) {
        process.stderr.write(JSON.stringify({
          component: "spectrum.stream", msg: "route_error",
          error: err instanceof Error ? err.message : "unknown",
        }) + "\n");
      }
    },
    log: (event) => {
      // Operational metadata only — no payload, no provider error strings.
      process.stderr.write(JSON.stringify({ component: "spectrum.stream", ...event }) + "\n");
    },
  });

  let retentionFailed = false;

  const retentionWorker = new TurnRetentionWorker({
    repository,
    observe: (event: RetentionLogEvent) => {
      process.stderr.write(JSON.stringify({ component: "turns.retention", ...event }) + "\n");
      if (event.msg === "turns.retention.failed") {
        retentionFailed = true;
      }
    },
  });
  const stopRetention = scheduleTurnRetention(
    retentionWorker,
    new IntervalRetentionSchedule((error) => {
      process.stderr.write(JSON.stringify({ component: "turns.retention", error: error.message }) + "\n");
    }),
  );

  await stream.start();

  let closed = false;

  return {
    async health() {
      if (closed) return { stream: "down", retention: "down" };
      const h = stream.health();
      return {
        stream: h.state === "connected" ? "up" : h.state === "degraded" ? "degraded" : "down",
        retention: retentionFailed ? "down" : "up",
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      stopRetention();
      await stream.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// main.ts integration — call from startRuntime after channel and DB are up.
// ---------------------------------------------------------------------------

export type Phase2Config = {
  enabled: boolean;
  user_id: string;
};

export type Phase2Enhancement = {
  readinessCheck: () => Promise<boolean>;
  close: () => Promise<void>;
};

export async function enhanceRuntimeWithPhase2(
  config: Phase2Config,
  phase2Deps: {
    db: Queryable;
    streamPort: SpectrumStreamPort;
    channel: Channel;
    keyProvider: HandleEnvelopeKeyProvider;
    selectorProvider: ChatSelectorProvider;
  } | null,
): Promise<Phase2Enhancement | null> {
  if (!config.enabled || phase2Deps === null) return null;

  const phase2 = await startPhase2Runtime({
    db: phase2Deps.db,
    user_id: config.user_id,
    streamPort: phase2Deps.streamPort,
    channel: phase2Deps.channel,
    keyProvider: phase2Deps.keyProvider,
    selectorProvider: phase2Deps.selectorProvider,
  });

  return {
    async readinessCheck(): Promise<boolean> {
      const h = await phase2.health();
      return h.stream !== "down" && h.retention === "up";
    },
    close: () => phase2.close(),
  };
}
