import { describe, expect, it } from "vitest";
import { classifyGatewayResponse, classifyRequestException, failureCopy } from "../src/lib/api-errors";

describe("API failure taxonomy (fakes-free UX)", () => {
  it("never leaks internals: titles/details are stable, user-safe strings", () => {
    const sensitive = /stack|trace|pgrst|postgres|groq_api_key|service_role|bearer|exception/i;
    for (const kind of ["not-configured", "network", "timeout", "auth", "rate-limit", "invalid-request", "server"] as const) {
      const f = failureCopy(kind);
      expect(f.title).not.toMatch(sensitive);
      expect(f.detail).not.toMatch(sensitive);
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.detail.length).toBeGreaterThan(0);
    }
  });

  it("maps gateway error codes to the right category", () => {
    expect(classifyGatewayResponse(503, "AI_GATEWAY_NOT_CONFIGURED").kind).toBe("not-configured");
    expect(classifyGatewayResponse(502, "AI_GATEWAY_ERROR").kind).toBe("server");
    expect(classifyGatewayResponse(502, "STREAM_FAILED").kind).toBe("server");
    expect(classifyGatewayResponse(429, "RATE_LIMITED_MINUTE").kind).toBe("rate-limit");
    expect(classifyGatewayResponse(429, "RATE_LIMITED_DAY").kind).toBe("rate-limit");
    expect(classifyGatewayResponse(401, "UNAUTHENTICATED").kind).toBe("auth");
    expect(classifyGatewayResponse(401, "INVALID_TOKEN").kind).toBe("auth");
  });

  it("falls back to status-code mapping for unknown codes", () => {
    expect(classifyGatewayResponse(401, null).kind).toBe("auth");
    expect(classifyGatewayResponse(403, null).kind).toBe("auth");
    expect(classifyGatewayResponse(429, null).kind).toBe("rate-limit");
    expect(classifyGatewayResponse(400, null).kind).toBe("invalid-request");
    expect(classifyGatewayResponse(500, null).kind).toBe("server");
    expect(classifyGatewayResponse(502, "SOMETHING_ELSE").kind).toBe("server");
  });

  it("classifies request exceptions: timeout vs network vs server", () => {
    expect(classifyRequestException(new DOMException("t", "TimeoutError")).kind).toBe("timeout");
    expect(classifyRequestException(new DOMException("a", "AbortError")).kind).toBe("timeout");
    expect(classifyRequestException(new TypeError("fetch failed")).kind).toBe("network");
    expect(classifyRequestException(new Error("odd")).kind).toBe("server");
  });

  it("auth failures suggest signing in; everything else is retryable", () => {
    expect(failureCopy("auth").action).toBe("sign-in");
    expect(failureCopy("auth").retryable).toBe(false);
    expect(failureCopy("server").retryable).toBe(true);
    expect(failureCopy("not-configured").retryable).toBe(true);
  });

  it("uses the spec vocabulary for the main failure", () => {
    expect(failureCopy("server").title).toBe("Server problem");
    expect(failureCopy("auth").title).toBe("Authentication failed");
    expect(failureCopy("server").detail).toContain("Please try again in a moment");
  });
});
