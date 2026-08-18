import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "MATRIX Documentation",
    template: "%s · MATRIX Documentation",
  },
  description: "Complete documentation for the MATRIX AI Cyber Safety Platform.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
