"use client";

// MATRIX animated cyber background — faint grid, drifting network nodes with
// connecting lines, slow binary particles, soft electric-blue highlights.
// Lightweight canvas: capped DPR, mobile-reduced density, static frame under
// prefers-reduced-motion, pauses when the tab is hidden.

import { useEffect, useRef } from "react";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  accent: boolean;
  text: string | null;
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
    const dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 1.25 : 1.75);

    let raf = 0;
    let running = true;
    let particles: Particle[] = [];
    const BINARY = ["0", "1"];

    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(70, Math.floor((w * h) / 22000)) * (isMobile ? 0.55 : 1);
      particles = Array.from({ length: Math.max(18, Math.floor(count)) }, (_, i) => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: 1 + Math.random() * 2.2,
        accent: i % 5 === 0,
        text: Math.random() < 0.16 ? BINARY[Math.floor(Math.random() * 2)] : null,
        phase: Math.random() * Math.PI * 2,
      }));
    };

    const draw = (t: number) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dark = document.documentElement.getAttribute("data-theme") !== "light";
      ctx.clearRect(0, 0, w, h);

      const gridLine = dark ? "rgba(170,190,240,0.05)" : "rgba(11,18,32,0.045)";
      const nodeLine = dark ? "rgba(122,162,255,0.14)" : "rgba(47,95,224,0.12)";
      const nodeCore = dark ? "rgba(122,162,255,0.55)" : "rgba(47,95,224,0.5)";
      const nodeDim = dark ? "rgba(170,190,240,0.22)" : "rgba(11,18,32,0.16)";
      const accent = dark ? "rgba(122,162,255,0.85)" : "rgba(47,95,224,0.85)";

      // Faint grid
      const step = 64;
      ctx.strokeStyle = gridLine;
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

      // Update particles
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.phase += 0.004;
        if (p.x < -20) p.x = w + 20;
        if (p.x > w + 20) p.x = -20;
        if (p.y < -20) p.y = h + 20;
        if (p.y > h + 20) p.y = -20;
      }

      // Connecting lines (distance-based)
      const LINK = 130;
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i];
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK * LINK) {
            const alpha = (1 - Math.sqrt(d2) / LINK) * 0.55;
            ctx.strokeStyle = nodeLine.replace("0.14", String((dark ? 0.14 : 0.12) * alpha));
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Nodes
      for (const p of particles) {
        if (p.accent) {
          const pulse = 0.6 + 0.4 * Math.sin(p.phase * 2);
          ctx.fillStyle = accent;
          ctx.globalAlpha = 0.25 * pulse;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.fillStyle = accent;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = nodeCore;
          ctx.globalAlpha = 0.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (p.text) {
          ctx.fillStyle = nodeDim;
          ctx.font = "10px ui-monospace, monospace";
          ctx.globalAlpha = 0.5;
          ctx.fillText(p.text, p.x + 5, p.y - 5);
          ctx.globalAlpha = 1;
        }
      }
    };

    const loop = (t: number) => {
      if (!running) return;
      draw(t);
      raf = requestAnimationFrame(loop);
    };

    resize();
    if (reduced) {
      // Static frame only — respect reduced motion.
      draw(0);
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

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10"
    />
  );
}
