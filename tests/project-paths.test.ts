import { describe, expect, it } from "vitest";
import { assertSafeProjectPath, buildFileTree, isValidDeploySlug, slugify } from "../src/lib/projects/paths";
import { createZip, readZip } from "../src/lib/projects/zip";

describe("project paths", () => {
  it("rejects traversal", () => {
    expect(() => assertSafeProjectPath("../secret")).toThrow();
    expect(assertSafeProjectPath("css/app.css")).toBe("css/app.css");
  });

  it("builds a folder tree", () => {
    const tree = buildFileTree(["index.html", "css/app.css", "js/main.js"]);
    expect(tree.some((n) => n.name === "css" && n.type === "folder")).toBe(true);
    expect(tree.some((n) => n.path === "index.html")).toBe(true);
  });

  it("validates deploy slugs", () => {
    expect(isValidDeploySlug("my-site")).toBe(true);
    expect(isValidDeploySlug("ab")).toBe(false);
    expect(isValidDeploySlug("My Site")).toBe(false);
    expect(slugify("My Cool Site!")).toBe("my-cool-site");
  });
});

describe("zip round-trip", () => {
  it("writes and reads text files", () => {
    const zip = createZip([{ path: "index.html", content: Buffer.from("<h1>Hi</h1>") }]);
    const entries = readZip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("index.html");
    expect(entries[0].content.toString("utf8")).toBe("<h1>Hi</h1>");
  });
});
