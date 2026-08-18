import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { AdminNav } from "@/components/admin/admin-nav";
import { CoursesAdmin } from "@/components/admin/courses-admin";

export const metadata: Metadata = { title: "Admin · Courses" };

export default async function AdminCoursesPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");
  const { data: perms } = await db.from("admin_permissions").select("code");
  const codes = new Set<string>((perms?.data ?? perms ?? []).map((p: { code: string }) => p.code));
  if (!demo && codes.size === 0) redirect("/chat");

  const { data: courses } = await db.from("courses").select("id, slug, title, level, status, sort_order").order("sort_order");
  const courseList = (courses?.data ?? courses ?? []) as { id: string; slug: string; title: string; level: string; status: string; sort_order: number }[];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Courses</h1>
      <AdminNav />
      <CoursesAdmin codes={codes} courses={courseList} />
    </div>
  );
}
