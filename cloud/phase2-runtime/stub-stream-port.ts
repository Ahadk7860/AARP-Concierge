// Stub SpectrumStreamPort for development and testing.
// Replaced by a documented Photon adapter before shipping.

import type { SpectrumStreamPort, SpectrumStreamObserver, SpectrumStreamOpenOptions, SpectrumStreamSession } from "../channel/src/spectrum-stream.js";

export function stubStreamPort(
  events: Array<{ id: string; cursor: string; payload: unknown }> = [],
): SpectrumStreamPort {
  let closed = false;
  return {
    async open(observer: SpectrumStreamObserver, _options: SpectrumStreamOpenOptions): Promise<SpectrumStreamSession> {
      // Yield preloaded events, then stay open but idle.
      for (const event of events) {
        if (closed) break;
        observer.event(event);
      }
      return {
        async close() { closed = true; },
      };
    },
  };
}
