"use client";

// The small on-screen control bar for the print view. It is marked `no-print`,
// so it never appears on paper. Printing is triggered once, automatically,
// after the fonts have settled — and can always be repeated manually.

import { useEffect, useRef } from "react";
import { Download, Printer } from "lucide-react";

export function PrintTrigger({ id, pdfHref }: { id: string; pdfHref: string }) {
  const printed = useRef(false);

  useEffect(() => {
    if (printed.current) return;
    printed.current = true;
    let cancelled = false;
    const run = () => {
      if (!cancelled) window.print();
    };
    // Wait for webfonts so the printed document uses the real typography.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) {
      void fonts.ready.then(() => window.setTimeout(run, 120));
    } else {
      window.setTimeout(run, 400);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-ink-2">
        Certificate <span className="mono text-ink">{id}</span>
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
          <Printer size={15} strokeWidth={1.8} aria-hidden="true" /> Print
        </button>
        <a className="btn btn-primary" href={pdfHref}>
          <Download size={15} strokeWidth={1.8} aria-hidden="true" /> Download PDF
        </a>
      </div>
    </div>
  );
}
