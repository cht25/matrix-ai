"use client";

import { useEffect, useState } from "react";
import { rpc } from "@/lib/client/api";
import { Card, Progress } from "@/components/ui";

export function UsagePanel() {
  const [data, setData] = useState<{ chat_used: number; chat_limit: number; scan_used: number; scan_limit: number } | null>(null);

  useEffect(() => {
    void rpc<typeof data>("usage_summary").then(setData).catch(() => setData({ chat_used: 0, chat_limit: 300, scan_used: 0, scan_limit: 50 }));
  }, []);

  if (!data) return null;
  return (
    <Card>
      <h2 className="font-bold text-ink">Today's usage</h2>
      <p className="mt-1 text-sm text-ink-2">Honest counts from the server. Limits are 300 chat and 50 scans per day.</p>
      <div className="mt-4 space-y-3">
        <div>
          <p className="text-xs text-ink-3">Chat {data.chat_used} / {data.chat_limit}</p>
          <Progress value={(data.chat_used / data.chat_limit) * 100} className="mt-1" />
        </div>
        <div>
          <p className="text-xs text-ink-3">Scanner {data.scan_used} / {data.scan_limit}</p>
          <Progress value={(data.scan_used / data.scan_limit) * 100} className="mt-1" />
        </div>
      </div>
    </Card>
  );
}
