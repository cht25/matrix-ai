// A tiny external store for the text of the reply that is currently streaming.
//
// The streamed text used to be React state on the whole chat screen, so every
// animation frame re-rendered the composer, the header, the sidebar wiring and
// the entire message history (2,000+ lines of JSX) to append a few characters.
// With the text here, only the one component that subscribes
// (`StreamingReply`) re-renders while tokens arrive.
export type StreamStore = {
  get(): string;
  set(value: string): void;
  subscribe(listener: () => void): () => void;
};

export function createStreamStore(): StreamStore {
  let value = "";
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
