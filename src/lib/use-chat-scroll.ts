"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type WheelEvent, type TouchEvent, type KeyboardEvent } from "react";
import { nearChatBottom } from "@/lib/chat-scroll";

/** Follow the real chat scroller, never the page. User-initiated upward scroll
 * stops following; layout changes are coalesced into one instant adjustment per
 * frame instead of stacking smooth-scroll animations on every token. */
export function useChatScroll(
  viewportRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  revision: unknown,
) {
  const following = useRef(true);
  const frame = useRef<number | null>(null);
  const pointerHeld = useRef(false);
  const prepending = useRef(false);
  const touchY = useRef<number | null>(null);
  const [newBelow, setNewBelow] = useState(false);

  const follow = useCallback(() => {
    following.current = true;
    setNewBelow(false);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const viewport = viewportRef.current;
      if (viewport && following.current) viewport.scrollTop = viewport.scrollHeight;
    });
  }, [viewportRef]);

  const schedule = useCallback(() => {
    if (prepending.current) return;
    if (!following.current) {
      setNewBelow(true);
      return;
    }
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const viewport = viewportRef.current;
      if (viewport && following.current) viewport.scrollTop = viewport.scrollHeight;
    });
  }, [viewportRef]);

  const pause = useCallback(() => { following.current = false; }, []);
  const beginPrepend = useCallback(() => { prepending.current = true; following.current = false; setNewBelow(false); }, []);
  const endPrepend = useCallback(() => { prepending.current = false; setNewBelow(false); }, []);
  const onScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || prepending.current) return;
    if (nearChatBottom(viewport.scrollHeight, viewport.clientHeight, viewport.scrollTop)) {
      following.current = true;
      setNewBelow(false);
    } else if (pointerHeld.current) {
      pause();
    }
  }, [viewportRef, pause]);
  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) pause();
  }, [pause]);
  const onTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    touchY.current = event.touches[0]?.clientY ?? null;
  }, []);
  const onTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const y = event.touches[0]?.clientY;
    if (touchY.current !== null && y !== undefined && y - touchY.current > 3) pause();
    touchY.current = y ?? null;
  }, [pause]);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pause();
  }, [pause]);

  // React committed a new chunk or message. The observer also handles images,
  // fonts, build logs and mobile keyboard changes that occur outside React.
  useLayoutEffect(() => { schedule(); }, [revision, schedule]);
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    observer.observe(content);
    schedule();
    return () => {
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [viewportRef, contentRef, schedule]);

  return {
    newBelow, follow, pause, beginPrepend, endPrepend, onScroll, onWheel, onTouchStart, onTouchMove, onKeyDown,
    onPointerDown: () => { pointerHeld.current = true; },
    onPointerUp: () => { pointerHeld.current = false; },
  };
}
