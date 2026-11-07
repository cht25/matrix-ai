import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  loadProjectFiles: vi.fn(),
  adminDb: vi.fn(),
  ownerId: "owner-1" as string | null,
  projectExists: true,
  files: [] as Array<{ path: string; content: string; language: string; encoding?: "utf8" | "base64" }>,
}));

vi.mock("@/lib/firebase/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/server/projects", () => ({ loadProjectFiles: mocks.loadProjectFiles }));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: mocks.adminDb,
}));

import { GET } from "../src/app/api/projects/[id]/preview/[[...path]]/route";

function request(path = "") {
  return new NextRequest(`http://localhost/api/projects/project-1/preview${path}`);
}

function context(path?: string[]) {
  return { params: Promise.resolve({ id: "project-1", path }) };
}

describe("GET /api/projects/[id]/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ownerId = "owner-1";
    mocks.projectExists = true;
    mocks.files = [
      { path: "index.html", language: "html", content: '<!doctype html><html><head><link rel="stylesheet" href="style.css"><script src="app.js"></script></head><body>Preview</body></html>' },
      { path: "style.css", language: "css", content: "body{color:purple}" },
      { path: "app.js", language: "javascript", content: "globalThis.previewLoaded=true;" },
      { path: "assets/pixel.png", language: "image", encoding: "base64", content: "aGVsbG8=" },
    ];
    mocks.getSessionUser.mockResolvedValue({ uid: "owner-1" });
    mocks.loadProjectFiles.mockImplementation(async () => mocks.files);
    mocks.adminDb.mockImplementation(() => ({
      collection: (name: string) => ({
        doc: (id: string) => ({
          get: async () => ({
            exists: name === "projects" && id === "project-1" && mocks.projectExists,
            data: () => ({ owner_id: mocks.ownerId }),
          }),
        }),
      }),
    }));
  });

  it("requires a signed-in user before reading project data", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
    expect(mocks.adminDb).not.toHaveBeenCalled();
    expect(mocks.loadProjectFiles).not.toHaveBeenCalled();
  });

  it("hides a missing project", async () => {
    mocks.projectExists = false;

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(mocks.loadProjectFiles).not.toHaveBeenCalled();
  });

  it("hides a project owned by another user", async () => {
    mocks.ownerId = "someone-else";

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(mocks.loadProjectFiles).not.toHaveBeenCalled();
  });

  it("serves an owner's root preview with inlined local assets and sandbox headers", async () => {
    const response = await GET(request(), context());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(html).toContain('<base href="/api/projects/project-1/preview/">');
    expect(html).toContain("body{color:purple}");
    expect(html).toContain("globalThis.previewLoaded=true;");
    expect(html).not.toContain('href="style.css"');
  });

  it("serves owned binary subresources with their real MIME type", async () => {
    const response = await GET(request("/assets/pixel.png"), context(["assets", "pixel.png"]));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("hello");
  });

  it("returns 404 for a missing resource rather than another project's content", async () => {
    const response = await GET(request("/missing.css"), context(["missing.css"]));

    expect(response.status).toBe(404);
  });
});
