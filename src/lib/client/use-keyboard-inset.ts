"use client";

// =============================================================================
// On-screen keyboard awareness for the chat surface.
//
// Mobile browsers disagree about what the keyboard does to the page:
//
//   iOS Safari, Chrome ≥ 108   the keyboard OVERLAYS the layout viewport; only
//                              `visualViewport` shrinks.
//   Firefox Android, WebViews  the layout viewport itself is RESIZED.
//
// Both are handled here and published to CSS, so layout never jumps through
// React state:
//
//   html[data-keyboard="open"]   the keyboard is up
//   --kb-inset                   pixels of the layout viewport it covers
//                                (0 when the browser already resized the page)
//
// styles/chat.css uses these to drop the bottom navigation and its reserved
// space while typing, so the composer sits directly on top of the keyboard.
// =============================================================================

import { useEffect } from "react";

/** Smaller changes are browser chrome (URL bar, toolbars), not a keyboard. */
const KEYBOARD_MIN_PX = 120;

export function keyboardState(input: {
  layoutHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
  /** Tallest layout viewport seen at this width (keyboard closed). */
  restingHeight: number;
  editing: boolean;
}): { open: boolean; inset: number } {
  const overlay = Math.max(0, Math.round(input.layoutHeight - input.visualHeight - input.visualOffsetTop));
  if (overlay >= KEYBOARD_MIN_PX) return { open: true, inset: overlay };
  const resized = input.restingHeight - input.layoutHeight;
  if (input.editing && resized >= KEYBOARD_MIN_PX) return { open: true, inset: 0 };
  return { open: false, inset: 0 };
}

function isEditing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "TEXTAREA" || el.isContentEditable || (el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "file", "range"].includes((el as HTMLInputElement).type));
}

export function useKeyboardInset(): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let resting = window.innerHeight;
    let width = window.innerWidth;
    let frame = 0;

    const apply = () => {
      frame = 0;
      // A rotation or window resize starts a new baseline.
      if (window.innerWidth !== width) { width = window.innerWidth; resting = window.innerHeight; }
      if (!isEditing()) resting = Math.max(resting, window.innerHeight);
      const state = keyboardState({
        layoutHeight: window.innerHeight,
        visualHeight: viewport?.height ?? window.innerHeight,
        visualOffsetTop: viewport?.offsetTop ?? 0,
        restingHeight: resting,
        editing: isEditing(),
      });
      if (state.open) root.dataset.keyboard = "open";
      else delete root.dataset.keyboard;
      root.style.setProperty("--kb-inset", `${state.inset}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };

    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    apply();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      delete root.dataset.keyboard;
      root.style.removeProperty("--kb-inset");
    };
  }, []);
}
