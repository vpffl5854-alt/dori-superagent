/** Start, idle and stop: the receiver's lifecycle, kept apart from the protocol it speaks. */
/** What the lifecycle reads and writes on the receiver. */
export type LifecycleDeps = {
  readonly setStopped: (v: boolean) => void;
  readonly caughtUp: Set<string>;
  readonly connect: () => void;
  readonly backfill: () => void;
  readonly clearHelloWait: () => void;
  readonly clearPendingReconnect: () => void;
  readonly clearBeat: () => void;
  readonly socket: () => { close(): void } | null;
  readonly setSocket: (s: null) => void;
  readonly chain: () => Promise<void>;
  readonly deliveries: () => Promise<void>;
  readonly cursorWrite: () => Promise<void>;
};

export const start = (d: LifecycleDeps): void => {
  d.setStopped(false);
  d.caughtUp.clear();
  d.connect();
  d.backfill();
};

/** Resolves once every message dispatched so far has been reported, media and all, and the
 * cursor file has caught up — tests await this instead of sleeping. */
export const idle = async (d: LifecycleDeps): Promise<void> => {
  for (;;) {
    const chain = d.chain();
    const deliveries = d.deliveries();
    const write = d.cursorWrite();
    await Promise.all([chain, deliveries, write]);
    if (chain === d.chain() && deliveries === d.deliveries() && write === d.cursorWrite()) return;
  }
};

export const stop = (d: LifecycleDeps): void => {
  d.setStopped(true);
  d.clearHelloWait();
  d.clearPendingReconnect();
  d.clearBeat();
  d.socket()?.close();
  d.setSocket(null);
};
