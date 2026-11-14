import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { describeExecutionRoutes, providerCatalogEntries } from "@/lib/ai/config";
import { providerPublicCode } from "@/lib/ai/provider-error";
import { preferenceForMode } from "@/lib/ai/model-preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public descriptors only. Credentials and internal endpoint URLs stay server-side. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const entries = await providerCatalogEntries(adminDb());
  const providers = await Promise.all(entries.map(async (entry) => {
    const base = { id: entry.id, name: entry.name, defaultModel: entry.defaultModel, codingModel: entry.codingModel, visionModel: entry.visionModel };
    try {
      if (!entry.client.listModels) throw new Error("Catalog unavailable");
      const models = await entry.client.listModels();
      return { ...base, models, verification: "account-catalog", verifiedAt: new Date().toISOString() };
    } catch (error) {
      return { ...base, models: [], error: providerPublicCode(error), verification: "unavailable" };
    }
  }));
  const settings = await adminDb().collection("user_security_settings").doc(user.uid).get();
  // The order the server will actually try, per mode — computed by the same
  // code that routes requests, so the page cannot drift from the backend.
  const [agentRoutes, chatRoutes] = await Promise.all([
    describeExecutionRoutes(adminDb(), "agent").catch(() => []),
    describeExecutionRoutes(adminDb(), "chat").catch(() => []),
  ]);
  return NextResponse.json({ providers, routing: { agent: agentRoutes, chat: chatRoutes }, preference: preferenceForMode(settings.data(), "chat"), preferences: { chat: preferenceForMode(settings.data(), "chat"), agent: preferenceForMode(settings.data(), "agent") }, reveal_mode: settings.data()?.stream_reveal_mode ?? "adaptive" }, { headers: { "Cache-Control": "private, no-store" } });
}
