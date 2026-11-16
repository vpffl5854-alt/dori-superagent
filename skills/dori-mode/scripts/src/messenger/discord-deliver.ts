/** One message at a time, so the lane sees every image cache-warm and in the order the messages arrived. */
import type { MediaRef } from "./discord-media.ts";
import type { Inbound, MediaStore } from "./discord-types.ts";

/** Queues one job behind the previous ones and returns it; the caller keeps the returned chain. */
export const deliver = (
  deliveries: Promise<void>,
  store: MediaStore | null,
  inbound: Inbound,
  refs: readonly MediaRef[],
  onInbound: (i: Inbound) => void,
  onEvent: (line: string) => void,
): Promise<void> => {
  const job = deliveries.then(async () => {
    if (!store || refs.length === 0) {
      onInbound(inbound);
      return;
    }
    const media: string[] = [];
    for (const [index, ref] of refs.entries()) {
      try {
        media.push(...(await store.save(inbound.messageId, index, ref)));
      } catch (e) {
        onEvent(`media download failed: ${(e as Error).message}`);
      }
    }
    onInbound(media.length > 0 ? { ...inbound, media } : inbound);
  });
  // The chain the next job queues behind swallows the failure; the returned job still rejects, so
  // the caller can leave the cursor behind and a restart prints the message again.
  const chain = job.catch((e) => onEvent(`media queue failed: ${(e as Error).message}`));
  chain.catch(() => {});
  return job;
};
