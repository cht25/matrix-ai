// =============================================================================
// Deep links — `qorvyna://` routing.
//
// The dangerous failure mode is a link that steers the app somewhere the user
// did not intend, so `parseDeepLink` returns `unknown` for every scheme/host it
// does not recognise instead of falling back to "navigate".
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDeepLink } from "../src/native/native-bridge";
import { parseLinkInput } from "../src/lib/device-links";

const ROOT = path.resolve(__dirname, "..");

describe("deep links — pairing", () => {
  it("extracts the pairing token from qorvyna://link?code=", () => {
    const intent = parseDeepLink("qorvyna://link?code=ABCD-EFGH");
    expect(intent).toEqual({ kind: "pair", token: "ABCD-EFGH" });
  });

  it("produces a token the pairing screen accepts unchanged", () => {
    const intent = parseDeepLink("qorvyna://pair?token=ABCD-EFGH");
    expect(intent.kind).toBe("pair");
    if (intent.kind === "pair") {
      expect(parseLinkInput(intent.token)).toBe("ABCD-EFGH");
    }
  });

  it("treats a link with no code as unknown rather than navigating", () => {
    expect(parseDeepLink("qorvyna://link").kind).toBe("unknown");
  });
});

describe("deep links — voice and navigation", () => {
  it("recognises the voice shortcut", () => {
    expect(parseDeepLink("qorvyna://voice")).toEqual({ kind: "voice" });
    expect(parseDeepLink("qorvyna://assistant")).toEqual({ kind: "voice" });
  });

  it("navigates in-app paths", () => {
    expect(parseDeepLink("qorvyna://chat/abc123")).toEqual({ kind: "navigate", path: "/chat/abc123" });
    expect(parseDeepLink("qorvyna://settings?tab=account")).toEqual({ kind: "navigate", path: "/settings?tab=account" });
  });

  it("accepts universal links on the canonical origin only", () => {
    expect(parseDeepLink("https://qorvyna.thamjj13.top/devices?link=ABCD-EFGH")).toEqual({
      kind: "navigate",
      path: "/devices?link=ABCD-EFGH",
    });
  });
});

describe("deep links — hostile input is refused", () => {
  it("rejects other schemes", () => {
    for (const url of ["https://evil.example/chat", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://x/y"]) {
      expect(parseDeepLink(url).kind, url).toBe("unknown");
    }
  });

  it("rejects look-alike hosts that merely contain the canonical name", () => {
    for (const url of [
      "https://qorvyna.thamjj13.top.evil.example/chat",
      "https://evilqorvyna.thamjj13.top.attacker.net/x",
      "https://qorvyna.thamjj13.top@evil.example/chat",
    ]) {
      expect(parseDeepLink(url).kind, url).toBe("unknown");
    }
  });

  it("handles empty and malformed input without throwing", () => {
    expect(parseDeepLink("").kind).toBe("unknown");
    expect(parseDeepLink(null).kind).toBe("unknown");
    expect(parseDeepLink("::::").kind).toBe("unknown");
  });
});

describe("deep links — wiring exists end to end", () => {
  it("declares the scheme in tauri.conf.json", () => {
    const conf = JSON.parse(readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.plugins["deep-link"].desktop.schemes).toContain("qorvyna");
  });

  it("registers the Rust plugin and forwards the URL as an event", () => {
    const rust = readFileSync(path.join(ROOT, "src-tauri/src/lib.rs"), "utf8");
    expect(rust).toContain("tauri_plugin_deep_link::init()");
    expect(rust).toContain("on_open_url");
    expect(rust).toContain("qorvyna://deep-link");
    // The pairing code must never be written to logs.
    expect(rust).toContain("scheme_only");
  });

  it("declares the crate dependency", () => {
    expect(readFileSync(path.join(ROOT, "src-tauri/Cargo.toml"), "utf8")).toContain("tauri-plugin-deep-link");
  });

  it("mounts the JS bridge inside the router", () => {
    const shell = readFileSync(path.join(ROOT, "src/native/native-app.tsx"), "utf8");
    expect(shell).toContain("DeepLinkBridge");
    expect(shell).toContain("onDeepLink");
    expect(shell).toContain("/devices?link=");
  });
});
