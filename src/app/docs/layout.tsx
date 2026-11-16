import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "QORVYNA Documentation",
    template: "%s · QORVYNA Documentation",
  },
  description: "Documentation for QORVYNA: the AI assistant and Agent, projects and hosting, connected devices, automation, cyber safety tools and account security.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
