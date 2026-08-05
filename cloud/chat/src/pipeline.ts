import type { ChatReply, DigestV2 } from "../../shared/src/contracts.js";
import { composeWaitingOnMeReply, freshnessDisclosure } from "./reply.js";
import { selectClosedChatQuery, type ChatSelectorProvider } from "./selector.js";
import { executeWaitingOnMe } from "./waiting-on-me.js";

function capabilityDecline(syncedThrough: string): ChatReply {
  return {
    schema_version: "chat_reply.v1",
    kind: "decline",
    text: `I can't answer that safely with the available chat capability. ${freshnessDisclosure(syncedThrough)}`,
    synced_through: syncedThrough,
    licenses: [],
  };
}

/**
 * The selector runs before, and without, relationship data. Only a validated named
 * selection lets the deterministic executor project evidence for the reply gate.
 */
export async function runClosedChat(
  question: string,
  digest: DigestV2,
  provider: ChatSelectorProvider,
): Promise<ChatReply> {
  const selection = await selectClosedChatQuery(question, provider);
  if (selection.kind === "decline") return capabilityDecline(digest.synced_through);
  return composeWaitingOnMeReply(executeWaitingOnMe(digest, selection.query));
}
