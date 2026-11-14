/** Shared, route-backed navigation. Never add a destination without a real page. */
export const PRIMARY_NAV = [
  { id: "new", label: "New Chat", href: "/chat?new=1" },
  { id: "chat", label: "Chat", href: "/chat" },
  { id: "agent", label: "Agent", href: "/chat?mode=agent" },
  { id: "workspace", label: "Workspace", href: "/workspace" },
  { id: "canvas", label: "Canvas", href: "/canvas" },
  { id: "automations", label: "Automations", href: "/automations" },
  { id: "devices", label: "Devices", href: "/devices" },
  { id: "family", label: "Family", href: "/family" },
  { id: "projects", label: "Projects", href: "/projects" },
  { id: "models", label: "AI model", href: "/models" },
  { id: "settings", label: "Settings", href: "/settings" },
] as const;

export const MOBILE_MORE_LABEL = "More";
export const MOBILE_NAV_IDS = ["chat", "agent", "automations", "devices"] as const;
export const MOBILE_NAV = MOBILE_NAV_IDS.map((id) => PRIMARY_NAV.find((item) => item.id === id)!);

export function navigationActive(pathname: string, search: URLSearchParams, href: string): boolean {
  const url = new URL(href, "https://navigation.invalid");
  if (url.pathname === "/chat") {
    if (pathname !== "/chat" && !pathname.startsWith("/chat/")) return false;
    const agent = pathname === "/chat" && search.get("mode") === "agent";
    return url.searchParams.get("mode") === "agent" ? agent : !agent;
  }
  return pathname === url.pathname || pathname.startsWith(`${url.pathname}/`);
}
