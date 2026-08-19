// =============================================================================
// MATRIX brand assets — hosted calligraphic identity.
// The wordmark and icon are served from Cloudinary so every surface
// (app chrome, login, certificates, favicons, manifest, OG cards) renders
// the exact same artwork.
// =============================================================================

/** Full calligraphic "Matrix" wordmark — black canvas, electric blue swashes. */
export const BRAND_WORDMARK_URL =
  "https://res.cloudinary.com/dxzbyknn/image/upload/v1787134563/ChatGPT_Image_Aug_18_2026_08_26_17_PM.png";

/** Square brand icon — used for favicons, PWA icons and the compact mark. */
export const BRAND_ICON_URL =
  "https://res.cloudinary.com/dxzbyknn/image/upload/v1787134771/df570753-79df-4dbd-842a-f4bdad67c298.png";

/** Signature colours sampled from the logo. */
export const BRAND_COLORS = {
  void: "#000104",
  ink: "#e8eefc",
  blue: "#1f6bff",
  blueDeep: "#0a3bd4",
  blueBright: "#5b9bff",
} as const;
