// Conversation grouping + formatting helpers for the sidebar.

export type SidebarConversation = {
  id: string;
  title: string;
  summary: string;
  updated_at: string;
  is_temporary: boolean;
  archived_at: string | null;
};

export type GroupKey = "today" | "yesterday" | "week" | "older";

export function groupLabel(key: GroupKey): string {
  switch (key) {
    case "today": return "Today";
    case "yesterday": return "Yesterday";
    case "week": return "Previous 7 days";
    case "older": return "Older";
  }
}

export function groupConversations(list: SidebarConversation[], now = new Date()): Record<GroupKey, SidebarConversation[]> {
  const groups: Record<GroupKey, SidebarConversation[]> = { today: [], yesterday: [], week: [], older: [] };
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;
  for (const c of list) {
    const t = new Date(c.updated_at).getTime();
    const dayDiff = Math.floor((startOfDay - t) / dayMs);
    const key: GroupKey = dayDiff <= 0 ? "today" : dayDiff === 1 ? "yesterday" : dayDiff <= 7 ? "week" : "older";
    groups[key].push(c);
  }
  return groups;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
