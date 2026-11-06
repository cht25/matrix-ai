// Native-client auth: Bearer Firebase ID tokens are accepted alongside the
// httpOnly session cookie, and verified server-side like the cookie path.
import { describe, expect, it } from "vitest";
import { extractBearerToken } from "@/lib/firebase/session";

describe("extractBearerToken", () => {
  it("parses Bearer tokens case-insensitively", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerToken("bearer   tok123  ")).toBe("tok123");
  });
  it("rejects missing or malformed headers", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
  });
});
