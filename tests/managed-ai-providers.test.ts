import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  getManagedProviderCatalogEntries,
  getManagedProviderRoutes,
  getManagedProvidersPublic,
  saveManagedProvider,
  setManagedModelFlags,
  setManagedProviderEnabled,
} from "@/lib/ai/managed-providers";
import { decryptSecret } from "@/lib/ai/image/config";
import { createAIRoutesFromDb } from "@/lib/ai/config";

let server: Server;
let base = "";
let saved: Record<string, unknown> | null = null;
let requests: { path: string; auth?: string }[] = [];
const previousEnv = {
  secret: process.env.PROVIDER_SECRET_KEY,
  localHttp: process.env.AI_ALLOW_LOCAL_HTTP,
};

function fakeDb() {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: Boolean(saved), data: () => saved ?? {} }),
      }),
    }),
    runTransaction: async (work: (tx: { get: (ref: unknown) => Promise<unknown>; set: (ref: unknown, data: Record<string, unknown>) => void }) => Promise<unknown>) => work({
      get: async () => ({ exists: Boolean(saved), data: () => saved ?? {} }),
      set: (_ref, data) => { saved = { ...(saved ?? {}), ...data }; },
    }),
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ path: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [
      { id: "chat-model", owned_by: "account" },
      { id: "agent-model", owned_by: "account" },
      { id: "vision-model", owned_by: "account" },
    ] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  saved = null;
  requests = [];
  process.env.PROVIDER_SECRET_KEY = "managed-provider-test-encryption-key";
  process.env.AI_ALLOW_LOCAL_HTTP = "true";
});
afterEach(() => {
  if (previousEnv.secret === undefined) delete process.env.PROVIDER_SECRET_KEY;
  else process.env.PROVIDER_SECRET_KEY = previousEnv.secret;
  if (previousEnv.localHttp === undefined) delete process.env.AI_ALLOW_LOCAL_HTTP;
  else process.env.AI_ALLOW_LOCAL_HTTP = previousEnv.localHttp;
});

const selectedModels = [
  { id: "chat-model", label: "Chat", enabled: true, use_for_chat: true, use_for_agent: false, use_for_vision: false },
  { id: "agent-model", label: "Agent", enabled: true, use_for_chat: false, use_for_agent: true, use_for_vision: false },
  { id: "vision-model", label: "Vision", enabled: false, use_for_chat: false, use_for_agent: false, use_for_vision: true },
];

describe("admin-managed AI provider registry", () => {
  it("stores multiple verified models encrypted and routes enabled models by task", async () => {
    const db = fakeDb() as never;
    const savedProvider = await saveManagedProvider(db, "admin-1", {
      name: "Team compatible endpoint",
      kind: "openai-compatible",
      base_url: base,
      api_key: "provider-secret-key",
      enabled: true,
      models: selectedModels,
    });

    expect(savedProvider.models).toHaveLength(3);
    expect(requests.map((request) => request.path)).toContain("/v1/models");
    expect(requests[0].auth).toBe("Bearer provider-secret-key");
    expect(JSON.stringify(saved)).not.toContain("provider-secret-key");
    const storedProvider = (saved?.providers as Array<Record<string, unknown>>)[0];
    expect(decryptSecret(String(storedProvider.api_key_encrypted))).toBe("provider-secret-key");

    expect((await getManagedProviderRoutes(db, "chat")).map((route) => route.model)).toEqual(["chat-model"]);
    expect((await getManagedProviderRoutes(db, "agent")).map((route) => route.model)).toEqual(["agent-model"]);
    expect((await createAIRoutesFromDb(db, false))[0]).toMatchObject({ providerId: savedProvider.id, model: "chat-model" });
    expect((await createAIRoutesFromDb(db, true))[0]).toMatchObject({ providerId: savedProvider.id, model: "agent-model" });
    expect((await getManagedProviderRoutes(db, "vision"))).toHaveLength(0);
    const publicProviders = await getManagedProvidersPublic(db);
    expect(publicProviders[0]).not.toHaveProperty("api_key_encrypted");
    expect(publicProviders[0]).not.toHaveProperty("api_key");
    expect(publicProviders[0].api_key_last4).toBe("-key");

    const entries = await getManagedProviderCatalogEntries(db);
    expect(entries[0].defaultModel).toBe("chat-model");
    expect(entries[0].codingModel).toBe("agent-model");
    expect((await entries[0].client.listModels?.())?.map((model) => model.id)).toEqual(["agent-model", "chat-model"]);
    expect(savedProvider.id).toMatch(/^[a-f0-9-]{36}$/i);
  });

  it("supports activation/deactivation without replacing the stored provider key", async () => {
    const db = fakeDb() as never;
    const provider = await saveManagedProvider(db, "admin-1", {
      name: "Primary",
      kind: "openai-compatible",
      base_url: base,
      api_key: "preserved-secret",
      enabled: true,
      models: [selectedModels[0]],
    });

    await setManagedProviderEnabled(db, provider.id, false);
    expect(await getManagedProviderRoutes(db, "chat")).toHaveLength(0);
    await setManagedProviderEnabled(db, provider.id, true);
    await setManagedModelFlags(db, { provider_id: provider.id, model_id: "chat-model", enabled: false });
    expect(await getManagedProviderRoutes(db, "chat")).toHaveLength(0);
    await setManagedModelFlags(db, { provider_id: provider.id, model_id: "chat-model", enabled: true, use_for_agent: true });
    expect((await getManagedProviderRoutes(db, "agent")).map((route) => route.model)).toEqual(["chat-model"]);
    expect(decryptSecret(String(((saved?.providers as Array<Record<string, unknown>>)[0]).api_key_encrypted))).toBe("preserved-secret");
  });

  it("refuses model IDs that the provider does not list", async () => {
    await expect(saveManagedProvider(fakeDb() as never, "admin-1", {
      name: "No guessed models",
      kind: "openai-compatible",
      base_url: base,
      api_key: "provider-key",
      enabled: true,
      models: [{ id: "invented-model", label: "Invented", enabled: true, use_for_chat: true, use_for_agent: false, use_for_vision: false }],
    })).rejects.toMatchObject({ code: "AI_MANAGED_MODEL_NOT_IN_CATALOG" });
  });
});
