"use client";

// MATRIX digital rain — persistent, site-wide background animation.
//
// Mounted once in the root layout (src/app/layout.tsx) behind every route:
// landing page, auth, chat, family, devices, automations, scanner, docs, admin.
//
// Behaviour:
//   · Plays everywhere by default ("normal") in both dark and light themes,
//     adapting glyph colour and trail opacity so foreground UI stays crisp;
//   · Scales column spacing and frame budget on compact screens to protect
//     mobile battery and scroll performance without hiding the effect;
//   · Pauses while the browser tab is hidden and renders a calm static field
//     when `prefers-reduced-motion: reduce` is enabled;
//   · User-controllable from Settings → Appearance (Off / Subtle / Normal / Heavy).

import { useEffect, useRef } from "react";

export const RAIN_STORAGE_KEY = "matrix-rain";
export type RainSetting = "off" | "subtle" | "normal" | "heavy";

const GLYPHS =
  "アァカサタナハマヤャラワガザダバパイィキシチニヒミリヰギジヂビピウゥクスツヌフムユュルグズブヅプエェケセテネヘメレゲゼデベペオォコソトノホモヨョロゴゾドボポヴッン0123456789MATRIX+=*<>¦";

const DENSITY: Record<
  Exclude<RainSetting, "off">,
  { font: number; speed: number; darkAlpha: number; lightAlpha: number; trailLen: number }
> = {
  subtle: { font: 15, speed: 0.48, darkAlpha: 0.16, lightAlpha: 0.11, trailLen: 6 },
  normal: { font: 16, speed: 0.85, darkAlpha: 0.28, lightAlpha: 0.18, trailLen: 10 },
  heavy: { font: 17, speed: 1.35, darkAlpha: 0.42, lightAlpha: 0.26, trailLen: 14 },
};

export function readRainSetting(): RainSetting {
  if (typeof window === "undefined") return "normal";
  try {
    const raw = window.localStorage.getItem(RAIN_STORAGE_KEY);
    if (raw === "off" || raw === "subtle" || raw === "normal" || raw === "heavy") return raw;
  } catch {
    /* private browsing */
  }
  return "normal";
}

export function applyRainSetting(setting: RainSetting): void {
  try {
    window.localStorage.setItem(RAIN_STORAGE_KEY, setting);
  } catch {
    /* private browsing */
  }
  document.documentElement.setAttribute("data-rain", setting);
  window.dispatchEvent(new CustomEvent("matrix-rain-change", { detail: setting }));
}

export function MatrixRain() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let setting = readRainSetting();
    let frame = 0;
    let columns = 0;
    let colStep = 16;
    let drops: number[] = [];
    let speeds: number[] = [];
    let chars: string[] = [];
    let last = 0;
    let width = 0;
    let height = 0;

    const isLight = () => document.documentElement.getAttribute("data-theme") === "light";

    function randomGlyph(): string {
      return GLYPHS[(Math.random() * GLYPHS.length) | 0];
    }

    function resize() {
      if (!canvas || !context) return;
      width = window.innerWidth;
      height = window.innerHeight;
      const mobile = width < 768;
      const dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      const spec = setting === "off" ? DENSITY.normal : DENSITY[setting];
      colStep = mobile ? Math.round(spec.font * 1.45) : spec.font;
      columns = Math.max(1, Math.floor(width / colStep));
      drops = Array.from({ length: columns }, () => Math.random() * height);
      speeds = Array.from(
        { length: columns },
        () => spec.font * spec.speed * (0.55 + Math.random() * 0.75),
      );
      chars = Array.from({ length: columns }, () => randomGlyph());
    }

    function palette(): { head: string; trail: string } {
      const style = getComputedStyle(document.documentElement);
      const primary = style.getPropertyValue("--primary").trim();
      if (isLight()) {
        return {
          head: primary || "#0284c7",
          trail: primary || "#0f766e",
        };
      }
      return {
        head: "#a7f3d0",
        trail: primary || "#10b981",
      };
    }

    function draw() {
      if (!context) return;
      const spec = setting === "off" ? DENSITY.normal : DENSITY[setting];
      const light = isLight();
      const baseAlpha = light ? spec.lightAlpha : spec.darkAlpha;
      const { head, trail } = palette();

      context.clearRect(0, 0, width, height);
      context.font = `${spec.font}px "JetBrains Mono", ui-monospace, monospace`;

      for (let index = 0; index < columns; index += 1) {
        const x = index * colStep;
        const headY = drops[index];
        if (Math.random() < 0.35) chars[index] = randomGlyph();

        // Trailing glyphs fading smoothly upward
        context.fillStyle = trail;
        for (let t = 1; t <= spec.trailLen; t += 1) {
          const y = headY - t * spec.font;
          if (y < -spec.font || y > height + spec.font) continue;
          const fade = 1 - t / (spec.trailLen + 1);
          context.globalAlpha = baseAlpha * fade * fade;
          const glyphIdx = (index * 7 + t * 13 + ((headY / spec.font) | 0)) % GLYPHS.length;
          context.fillText(GLYPHS[(glyphIdx + GLYPHS.length) % GLYPHS.length], x, y);
        }

        // Bright leading glyph
        if (headY >= -spec.font && headY <= height + spec.font) {
          context.globalAlpha = Math.min(0.9, baseAlpha * 2.6);
          context.fillStyle = head;
          context.fillText(chars[index], x, headY);
        }

        drops[index] += speeds[index] * 0.42;
        if (drops[index] - spec.trailLen * spec.font > height) {
          drops[index] = Math.random() * -height * 0.35;
          speeds[index] = spec.font * spec.speed * (0.55 + Math.random() * 0.75);
        }
      }
      context.globalAlpha = 1;
    }

    function loop(now: number) {
      frame = window.requestAnimationFrame(loop);
      const minDelta = width < 768 ? 48 : 33;
      if (now - last < minDelta) return;
      last = now;
      draw();
    }

    function start() {
      stop();
      setting = readRainSetting();
      if (setting === "off") {
        context?.clearRect(0, 0, width, height);
        return;
      }
      resize();
      if (reduceMotion.matches) {
        draw();
        return;
      }
      frame = window.requestAnimationFrame(loop);
    }

    function stop() {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    }

    function onVisibility() {
      if (document.hidden) stop();
      else start();
    }

    function onSetting(event: Event) {
      const detail = (event as CustomEvent<RainSetting>).detail;
      setting = detail ?? readRainSetting();
      start();
    }

    const themeObserver = new MutationObserver(() => start());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-rain"],
    });

    window.addEventListener("resize", resize);
    window.addEventListener("matrix-rain-change", onSetting);
    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      stop();
      themeObserver.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("matrix-rain-change", onSetting);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="matrix-rain" aria-hidden="true" />;
}
