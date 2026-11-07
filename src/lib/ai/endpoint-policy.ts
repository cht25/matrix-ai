import { isIP } from "node:net";

/** Reject credentials and obvious internal targets. HTTPS is the default;
 * an operator may explicitly allow HTTP for a local Ollama/custom provider.
 * Public custom DNS names remain supported for compatible providers. Deploy
 * behind an egress firewall too: application validation is not DNS pinning.
 */
export function isProviderEndpointAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const local = host === "localhost" || host.endsWith(".localhost") || host === "host.docker.internal";
    if (url.protocol === "http:") {
      if (process.env.AI_ALLOW_LOCAL_HTTP !== "true") return false;
      if (!local && isIP(host)) return privateIp(host);
      return local || !privateIp(host);
    }
    if (url.protocol !== "https:") return false;
    return !local && !privateIp(host);
  } catch { return false; }
}

function privateIp(host: string): boolean {
  const version = isIP(host);
  if (!version) return false; // DNS/egress policy is a deployment responsibility.
  if (version === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  return host === "::" || host === "::1" || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host) || host.startsWith("::ffff:") || host.startsWith("2001:db8:");
}
