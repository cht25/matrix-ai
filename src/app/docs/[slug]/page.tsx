import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDocSection } from "@/content/docs";
import { DocsShell, DocRenderer } from "@/components/docs/docs-shell";

export const dynamicParams = true;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const section = getDocSection(slug);
  if (!section) return { title: "Not found" };
  return { title: section.title };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const section = getDocSection(slug);
  if (!section) notFound();

  return (
    <DocsShell slug={slug}>
      <DocRenderer section={section} />
    </DocsShell>
  );
}
