"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "qorvyna:robotics-bg";

export function RoboticsBackground() {
  const [enabled, setEnabled] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "off") setEnabled(false);
    } catch { /* ignore */ }

    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (mq) {
      setReducedMotion(mq.matches);
      const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
  }, []);

  useEffect(() => {
    const onVisibility = () => setPageHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  if (!enabled) return null;

  const animate = !reducedMotion && !pageHidden;

  return (
    <div
      aria-hidden="true"
      data-testid="robotics-background"
      data-animate={animate ? "true" : "false"}
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none"
    >
      {/* Deep navy / cyan / violet laboratory lighting */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 75% 55% at 15% 20%, rgba(14, 165, 233, 0.10), transparent 65%), radial-gradient(ellipse 65% 50% at 85% 75%, rgba(139, 92, 246, 0.11), transparent 65%), radial-gradient(ellipse 50% 40% at 50% 50%, rgba(30, 58, 138, 0.08), transparent 70%)",
        }}
      />

      {/* Subtle architectural lab grid */}
      <svg className="absolute inset-0 h-full w-full opacity-[0.06]" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="qorvyna-lab-grid" width="48" height="48" patternUnits="userSpaceOnUse">
            <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#38bdf8" strokeWidth="0.6" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#qorvyna-lab-grid)" />
      </svg>

      {/* Articulated Robotic Arm + Holographic HUD + Neural Network */}
      <svg
        viewBox="0 0 1200 720"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 h-full w-full opacity-[0.22]"
      >
        <defs>
          <linearGradient id="armGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.5" />
          </linearGradient>
        </defs>

        {/* Holographic HUD rings */}
        <g transform="translate(930 220)" stroke="#38bdf8" fill="none" strokeOpacity="0.35">
          <circle r="110" strokeWidth="0.8" strokeDasharray="8 6">
            {animate ? (
              <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="36s" repeatCount="indefinite" />
            ) : null}
          </circle>
          <circle r="76" strokeWidth="1" strokeDasharray="18 10" stroke="#8b5cf6">
            {animate ? (
              <animateTransform attributeName="transform" type="rotate" from="360" to="0" dur="24s" repeatCount="indefinite" />
            ) : null}
          </circle>
          <circle r="38" strokeWidth="0.7" />
        </g>

        {/* Articulated Robotic Arm */}
        <g transform="translate(180 620)" stroke="url(#armGrad)" fill="none" strokeLinecap="round">
          <rect x="-42" y="-16" width="84" height="16" rx="4" strokeWidth="1.5" />
          <g>
            {animate ? (
              <animateTransform attributeName="transform" type="rotate" values="-8;6;-8" dur="14s" repeatCount="indefinite" />
            ) : null}
            <line x1="0" y1="-16" x2="70" y2="-165" strokeWidth="4" />
            <circle cx="70" cy="-165" r="8" fill="#0ea5e9" fillOpacity="0.3" strokeWidth="1.5" />
            <g transform="translate(70 -165)">
              {animate ? (
                <animateTransform attributeName="transform" type="rotate" values="12;-14;12" dur="10s" repeatCount="indefinite" />
              ) : null}
              <line x1="0" y1="0" x2="115" y2="-48" strokeWidth="3" />
              <circle cx="115" cy="-48" r="6" fill="#8b5cf6" fillOpacity="0.35" strokeWidth="1.5" />
              <path d="M 115 -48 L 138 -60 M 115 -48 L 136 -34" strokeWidth="1.8" />
            </g>
          </g>
        </g>

        {/* Neural Network Nodes & Synapses */}
        <g stroke="#38bdf8" strokeOpacity="0.28" strokeWidth="0.9">
          <line x1="520" y1="160" x2="680" y2="210" />
          <line x1="680" y1="210" x2="820" y2="150" />
          <line x1="680" y1="210" x2="740" y2="330" />
          <line x1="520" y1="160" x2="580" y2="310" />
          <line x1="580" y1="310" x2="740" y2="330" />
        </g>
        {[
          [520, 160],
          [680, 210],
          [820, 150],
          [580, 310],
          [740, 330],
        ].map(([cx, cy], idx) => (
          <circle key={idx} cx={cx} cy={cy} r="4" fill="#38bdf8" fillOpacity="0.55">
            {animate ? (
              <animate attributeName="opacity" values="0.3;0.9;0.3" dur={`${3 + idx}s`} repeatCount="indefinite" />
            ) : null}
          </circle>
        ))}
      </svg>
    </div>
  );
}
