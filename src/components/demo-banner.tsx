import { isDemoMode } from "@/lib/data";

export function DemoModeBanner() {
  if (!isDemoMode()) return null;
  return (
    <div className="relative z-50 border-b border-warning/30 bg-warning-soft px-4 py-1.5 text-center text-[11px] font-medium uppercase tracking-[0.14em] text-warning" role="note">
      Demo mode — preview only · no real data · AI gateway disabled
    </div>
  );
}
