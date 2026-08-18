import { redirect } from "next/navigation";
import Link from "next/link";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { Logo } from "@/components/logo";
import { SignOutButton } from "@/components/sign-out-button";
import { env } from "@/lib/env";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: "📊" },
  { href: "/chat", label: "AI Chat", icon: "💬" },
  { href: "/temporary-chat", label: "Temporary Chat", icon: "🕒" },
  { href: "/scanner", label: "Scanner", icon: "🔍" },
  { href: "/scams", label: "Scam Library", icon: "🛡️" },
  { href: "/report", label: "Report a Scam", icon: "📢" },
  { href: "/courses", label: "Courses", icon: "🎓" },
  { href: "/certificate", label: "Certificates", icon: "🏅" },
  { href: "/history", label: "History", icon: "🗂️" },
  { href: "/security", label: "Security", icon: "🔐" },
  { href: "/settings", label: "Settings", icon: "⚙️" },
  { href: "/emergency", label: "I Need Help Now", icon: "🚨" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();

  if (!user && !demo) redirect("/login");

  // Admin link only when the user holds any admin role.
  let isAdmin = false;
  if (!demo) {
    const { data } = await db.rpc("is_admin");
    isAdmin = Boolean(data);
  }

  return (
    <div className="min-h-screen bg-slate-50 lg:flex">
      {/* Sidebar */}
      <aside className="border-b border-slate-200 bg-white lg:sticky lg:top-0 lg:h-screen lg:w-64 lg:shrink-0 lg:border-r lg:border-b-0">
        <div className="flex h-16 items-center justify-between px-4 lg:h-auto lg:justify-start lg:px-5 lg:pt-5">
          <Logo size="sm" />
        </div>
        <nav aria-label="App navigation" className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-3 lg:pb-4">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            >
              <span aria-hidden="true">{item.icon}</span>
              <span className="whitespace-nowrap lg:whitespace-normal">{item.label}</span>
            </Link>
          ))}
          {isAdmin ? (
            <Link href="/admin" className="flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50">
              <span aria-hidden="true">🛠️</span> Admin
            </Link>
          ) : null}
          <div className="mt-auto hidden pt-4 lg:block">
            <div className="border-t border-slate-100 pt-3">
              <p className="mb-2 truncate px-3 text-xs text-slate-400">
                {demo ? "Demo user · " : ""}{user?.email ?? "Signed in"}
              </p>
              <SignOutButton />
            </div>
          </div>
        </nav>
      </aside>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:py-8">{children}</div>
        {env.demoMode ? null : (
          <p className="pb-8 text-center text-xs text-slate-400">
            MATRIX AI · THAMJJ13.TOP White Hat Team · If you are in danger, tell a trusted adult
          </p>
        )}
      </div>
    </div>
  );
}
