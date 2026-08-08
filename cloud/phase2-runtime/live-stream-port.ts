// Concrete SpectrumStreamPort backed by the Photon SDK (photon.codes).
//
// Uses PlatformInstance.messages (AsyncIterable<[Space, Message]>) from the SDK.
// Restart replays from the beginning; SpectrumStream handles deduplication.

import { imessage } from "@spectrum-ts/imessage";
import type { Space, Message, SpectrumInstance } from "@spectrum-ts/core";

import type {
  SpectrumStreamPort,
  SpectrumStreamObserver,
  SpectrumStreamOpenOptions,
  SpectrumStreamSession,
  SpectrumStreamEvent,
} from "../channel/src/spectrum-stream.js";

export function liveSpectrumStreamPort(app: SpectrumInstance): SpectrumStreamPort {
  const platform = imessage(app);

  return {
    async open(
      observer: SpectrumStreamObserver,
      _options: SpectrumStreamOpenOptions,
    ): Promise<SpectrumStreamSession> {
      const messages: AsyncIterable<[Space, Message]> = platform.messages;
      let stopped = false;

      const consumption = (async () => {
        try {
          for await (const [space, message] of messages) {
            if (stopped) break;
            if (message.direction !== "inbound" || !message.id) continue;
            const event: SpectrumStreamEvent = {
              id: message.id,
              cursor: message.id,
              payload: { space, message },
            };
            observer.event(event);
          }
          observer.ended();
        } catch (error) {
          observer.ended(error);
        }
      })();

      return {
        async close() {
          stopped = true;
          await consumption.catch(() => {});
        },
      };
    },
  };
}
