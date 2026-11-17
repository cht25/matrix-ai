"use client";

// Native shell `next/image` replacement: a real <img> with the same props the
// shared components pass. QORVYNA renders no build-time optimised images
// (avatars come from Cloudinary/Google and brand art is SVG), so the Next
// image pipeline is not needed — but the import path must stay identical.
import type { CSSProperties, ReactNode } from "react";

type ImageProps = {
  src: string | { src: string; width?: number; height?: number };
  alt: string;
  width?: number | string;
  height?: number | string;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  placeholder?: string;
  blurDataURL?: string;
  loader?: unknown;
  unoptimized?: boolean;
  sizes?: string;
  className?: string;
  style?: CSSProperties;
  loading?: "eager" | "lazy";
  onLoad?: () => void;
  onError?: () => void;
  children?: ReactNode;
};

export default function Image({
  src,
  alt,
  width,
  height,
  fill,
  priority,
  className,
  style,
  sizes,
  onLoad,
  onError,
}: ImageProps) {
  const resolved = typeof src === "string" ? src : src?.src ?? "";
  const fillStyle: CSSProperties = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", ...style }
    : style ?? {};
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={resolved}
      alt={alt}
      width={fill ? undefined : width}
      height={fill ? undefined : height}
      sizes={sizes}
      className={className}
      style={fillStyle}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      onLoad={onLoad}
      onError={onError}
    />
  );
}
