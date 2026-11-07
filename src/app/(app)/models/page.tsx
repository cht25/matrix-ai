import type { Metadata } from "next";
import { ModelsClient } from "@/components/models-client";

export const metadata: Metadata = { title: "Models" };
export const dynamic = "force-dynamic";

export default function ModelsPage() { return <ModelsClient />; }
