"use client";

// MATRIX ambient background — a quiet, cinematic cyber-intelligence
// environment: fine geometric grid, sparse network topology, thin data
// paths, minimal particles, faint technical glyphs. Monochrome, extremely
// subtle, reduced-motion aware, mobile-reduced, pauses when hidden.

import { useEffect, useRef } from "react";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  glyph: string | null;
  phase: number;
};

export function CyberBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isMobile = window.innerWidth < 768;
    const dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 1.25 : 1.5);

    let raf = 0;
    let running = true;
    let particles: Particle[] = [];
    const GLYPHS = ["0", "1", "·", "×", "+", "//"];

    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(46, Math.floor((w * h) / 34000)) * (isMobile ? 0.5 : 1);
      particles = Array.from({ length: Math.max(10, Math.floor(count)) }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.14,
        vy: (Math.random() - 0.5) * 0.14,
        r: 0.8 + Math.random() * 1.4,
        glyph: Math.random() < 0.12 ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)] : null,
        phase: Math.random() * Math.PI * 2,
      }));
    };

    const draw = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dark = document.documentElement.getAttribute("data-theme") !== "light";
      ctx.clearRect(0, 0, w, h);

      const grid = dark ? "rgba(120,165,255,0.045)" : "rgba(10,30,80,0.04)";
      const line = dark ? "rgba(63,128,255,0.11)" : "rgba(18,68,214,0.1)";
      const node = dark ? "rgba(91,155,255,0.38)" : "rgba(18,68,214,0.32)";
      const glyph = dark ? "rgba(138,182,255,0.16)" : "rgba(10,30,80,0.13)";

      // Fine geometric grid
      const step = 72;
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x += step) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = 0; y <= h; y += step) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();

      // Sparse network topology
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.phase += 0.002;
        if (p.x < -16) p.x = w + 16;
        if (p.x > w + 16) p.x = -16;
        if (p.y < -16) p.y = h + 16;
        if (p.y > h + 16) p.y = -16;
      }

      const LINK = 150;
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i];
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK * LINK) {
            const alpha = (1 - Math.sqrt(d2) / LINK) * 0.5;
            ctx.strokeStyle = line.replace("0.075", String(0.075 * alpha)).replace("0.08", String(0.08 * alpha));
            ctx.lineWidth = 0.75;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      for (const p of particles) {
        ctx.fillStyle = node;
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(p.phase * 2);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (p.glyph) {
          ctx.fillStyle = glyph;
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText(p.glyph, p.x + 5, p.y - 5);
        }
      }
    };

    const loop = () => {
      if (!running) return;
      draw();
      raf = requestAnimationFrame(loop);
    };

    resize();
    if (reduced) {
      draw();
    } else {
      raf = requestAnimationFrame(loop);
    }

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!reduced) {
        running = true;
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", resize);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10" />;
}
