// =============================================================================
// Deployment settings that carry the product name.
//
// The product was renamed from MATRIX to QORVYNA. Settings are now read as
// `QORVYNA_<NAME>`; the earlier `MATRIX_<NAME>` is still honoured so that an
// existing deployment keeps working without anyone touching its environment.
// When both are set, the new name wins.
//
// Pure (takes the environment as an argument) so it is unit tested and can be
// used from server code and scripts alike.
// =============================================================================

type Env = Record<string, string | undefined>;

/** `QORVYNA_<NAME>`, falling back to the legacy `MATRIX_<NAME>`. */
export function brandEnv(name: string, env: Env = process.env): string | undefined {
  const current = env[`QORVYNA_${name}`];
  if (current !== undefined && current.trim() !== "") return current;
  const legacy = env[`MATRIX_${name}`];
  return legacy !== undefined && legacy.trim() !== "" ? legacy : undefined;
}

/** Which variable supplied the value — for diagnostics; never the value itself. */
export function brandEnvSource(name: string, env: Env = process.env): "QORVYNA" | "MATRIX" | null {
  if ((env[`QORVYNA_${name}`] ?? "").trim() !== "") return "QORVYNA";
  if ((env[`MATRIX_${name}`] ?? "").trim() !== "") return "MATRIX";
  return null;
}
