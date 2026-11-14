"use client";

import { memo, useSyncExternalStore } from "react";
import { Markdown } from "@/components/markdown";
import type { StreamStore } from "@/lib/stream-store";

const empty = () => "";

/**
 * The live reply. Subscribes to the stream store directly so token updates
 * re-render this component only — not the chat screen around it.
 */
export const StreamingReply = memo(function StreamingReply({ store }: { store: StreamStore }) {
  const text = useSyncExternalStore(store.subscribe, store.get, empty);
  if (!text) return null;
  return <Markdown text={text} streaming />;
});
