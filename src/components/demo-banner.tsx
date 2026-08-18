import { isDemoMode } from "@/lib/data";

export function DemoModeBanner() {
  if (!isDemoMode()) return null;
  return (
    <div className="relative z-50 bg-warning px-4 py-1.5 text-center text-xs font-bold text-[#1a1206]" role="note">
      DEMO MODE — preview only · no real data is stored · AI gateway disabled · never enable in production
    </div>
  );
}
