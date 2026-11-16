// =============================================================================
// QORVYNA brand geometry — the single design source for the emblem and the
// wordmark. Everything is plain vector maths (no fonts, no traced bitmaps), so
// every logo file, app icon and the in-app <Logo> render the same shapes.
//
//   node scripts/generate-brand-assets.mjs
//
// regenerates src/lib/brand-geometry.json, public/brand/* and every icon.
// =============================================================================

/** Palette extracted from the supplied QORVYNA logo. */
export const PALETTE = {
  cyan: "#22CCFF",
  blue: "#2563FF",
  blueDeep: "#1437D6",
  violet: "#7C3AED",
  violetBright: "#9D5CFF",
  navy: "#070B1E",
  navyRaised: "#0D1433",
  ink: "#0B1533",
  white: "#F5F8FF",
  gray: "#94A3B8",
};

const n = (value) => Number(value.toFixed(2));

// --- Emblem (512 × 512) ------------------------------------------------------
// A bold "Q": gradient ring + diagonal tail, crossed by a tilted orbit that
// passes behind the ring on its far side and in front on its near side, with a
// small glowing body riding the orbit.
export const EMBLEM = (() => {
  const ring = { cx: 240, cy: 264, outer: 156, inner: 100 };
  const tail = [[212, 264], [300, 264], [438, 396], [350, 396]];
  // The orbit is the outline between two offset ellipses, so it swells into a
  // crescent at its near (lower-left) end and tapers to a line at the far end.
  const orbit = { cx: 246, cy: 252, tilt: -23, outer: { rx: 236, ry: 58 }, hole: { dx: 19, dy: -3.5, rx: 211, ry: 47.5 } };
  const body = { cx: 414, cy: 143, r: 18, halo: 40 };

  const circle = (cx, cy, r) => `M${n(cx - r)} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  const ellipse = (cx, cy, rx, ry) => `M${n(cx - rx)} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;

  return {
    size: 512,
    ring,
    ringPath: `${circle(ring.cx, ring.cy, ring.outer)}${circle(ring.cx, ring.cy, ring.inner)}`,
    /** The Q's silhouette (plus a hair): the far side of the orbit hides behind it. */
    behindPath: circle(ring.cx, ring.cy, ring.outer + 7),
    tailPath: `M${tail.map((p) => p.join(" ")).join("L")}Z`,
    orbit,
    orbitTransform: `translate(${orbit.cx} ${orbit.cy}) rotate(${orbit.tilt})`,
    orbitPath: `${ellipse(0, 0, orbit.outer.rx, orbit.outer.ry)}${ellipse(orbit.hole.dx, orbit.hole.dy, orbit.hole.rx, orbit.hole.ry)}`,
    body,
  };
})();

// --- Small emblem (favicons, ≤ 48 px) ----------------------------------------
// Same Q, heavier strokes, no orbit: an orbit thinner than a pixel only adds
// blur. The body stays so the mark is still recognisably the same symbol.
export const EMBLEM_SMALL = (() => {
  const ring = { cx: 226, cy: 282, outer: 190, inner: 104 };
  const tail = [[196, 282], [316, 282], [478, 470], [358, 470]];
  const body = { cx: 432, cy: 84, r: 50 };
  const circle = (cx, cy, r) => `M${n(cx - r)} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  return {
    size: 512,
    ring,
    ringPath: `${circle(ring.cx, ring.cy, ring.outer)}${circle(ring.cx, ring.cy, ring.inner)}`,
    tailPath: `M${tail.map((p) => p.join(" ")).join("L")}Z`,
    body,
  };
})();

// --- Wordmark ("QORVYNA", cap height 100) ------------------------------------
// Wide geometric capitals drawn as shapes. `ink` takes the text colour; the
// two `accent` shapes (the Q's tail and the A's inner triangle) take the brand
// gradient, exactly as in the supplied logo. Shapes never overlap, so the
// wordmark also renders correctly at reduced opacity.
export const WORDMARK = (() => {
  const H = 100; // cap height
  const W = 28; // stroke weight
  const GAP = 14; // letter spacing
  const ink = [];
  const accent = [];
  let x = 0;

  const at = (px) => n(x + px);
  const poly = (points) => `M${points.map(([px, py]) => `${at(px)} ${n(py)}`).join("L")}Z`;
  /** Rounded rectangle as a closed sub-path. */
  const rrect = (left, top, width, height, r) =>
    `M${at(left + r)} ${n(top)}h${n(width - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}v${n(height - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${r}h${n(-(width - 2 * r))}a${r} ${r} 0 0 1 ${-r} ${-r}v${n(-(height - 2 * r))}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
  const bowl = (width) => `${rrect(0, 0, width, H, 42)}${rrect(W, W, width - 2 * W, H - 2 * W, 42 - W)}`;

  // Q — a bowl with a clean gap where the accent tail leaves it.
  const qWidth = 138;
  const qBowl = bowl(qWidth);
  accent.push(poly([[54, 55], [90, 55], [qWidth + 4, H], [qWidth - 32, H]]));
  const qTailGap = poly([[40, 47], [97, 47], [qWidth + 18, H + 8], [qWidth - 46, H + 8]]);
  x += qWidth + GAP;

  // O
  const oWidth = 134;
  ink.push(bowl(oWidth));
  x += oWidth + GAP;

  // R — stem, bowl and diagonal leg as ONE contour (no seams between parts).
  const rBar = 82; // where the bowl's straight bars end
  const rOuter = 35; // bowl outer radius (bowl height 70)
  const rWidth = 120;
  ink.push(
    `M${at(0)} 0H${at(rBar)}a${rOuter} ${rOuter} 0 0 1 0 ${2 * rOuter}L${at(rWidth)} ${H}H${at(rWidth - 36)}L${at(48)} ${2 * rOuter}H${at(W)}V${H}H${at(0)}Z` +
    `M${at(W)} ${W}H${at(rBar)}a${rOuter - W} ${rOuter - W} 0 0 1 0 ${2 * (rOuter - W)}H${at(W)}Z`,
  );
  x += rWidth + GAP - 4;

  // V
  const vWidth = 130;
  ink.push(poly([[0, 0], [32, 0], [vWidth / 2, 62], [vWidth - 32, 0], [vWidth, 0], [vWidth / 2 + 17, H], [vWidth / 2 - 17, H]]));
  x += vWidth + GAP - 10;

  // Y
  const yWidth = 128;
  ink.push(poly([[0, 0], [33, 0], [yWidth / 2, 37], [yWidth - 33, 0], [yWidth, 0], [yWidth / 2 + W / 2, 60], [yWidth / 2 + W / 2, H], [yWidth / 2 - W / 2, H], [yWidth / 2 - W / 2, 60]]));
  x += yWidth + GAP - 6;

  // N
  const nWidth = 124;
  ink.push(poly([[0, H], [0, 0], [30, 0], [nWidth - W, 57], [nWidth - W, 0], [nWidth, 0], [nWidth, H], [nWidth - 30, H], [W, 43], [W, H]]));
  x += nWidth + GAP - 2;

  // A — crossbar-less capital with the accent triangle as its counter.
  const aWidth = 140;
  ink.push(poly([[0, H], [54, 0], [aWidth - 54, 0], [aWidth, H], [aWidth - 33, H], [aWidth / 2, 34], [33, H]]));
  accent.push(poly([[aWidth / 2, 58], [aWidth / 2 + 22, H], [aWidth / 2 - 22, H]]));
  x += aWidth;

  return { width: n(x), height: H, qBowl, qTailGap, ink, accent };
})();
