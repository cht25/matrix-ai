import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { AdminNav } from "@/components/admin/admin-nav";
import { CoursesAdmin } from "@/components/admin/courses-admin";

export const metadata: Metadata = { title: "Admin · Courses" };

export default async function AdminCoursesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  if (codes.length === 0) redirect("/chat");

  const d = db();
  const courseDocs = await d.collection("courses").get();
  const courseList = courseDocs.docs
    .map((c) => ({ id: c.id, slug: c.data().slug, title: c.data().title, level: c.data().level ?? "beginner", status: c.data().status ?? "published", sort_order: c.data().sort_order ?? 0 }))
    .sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Courses</h1>
      <AdminNav />
      <CoursesAdmin codes={codes} courses={courseList} />
    </div>
  );
}
