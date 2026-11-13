# Z.ai GLM setup and verification

Set provider secrets **only on the server** (host runtime environment), then redeploy. Do not use `NEXT_PUBLIC_` variables for keys.

| Account/gateway | Key | Chat API base URL |
|---|---|---|
| Z.ai international | `ZAI_API_KEY` | `https://api.z.ai/api/paas/v4` (automatic if `GLM_BASE_URL` is unset) |
| Mainland Zhipu | `GLM_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` (default if `ZAI_API_KEY` is unset) |

For an existing deployment that already uses `GLM_API_KEY` with a **Z.ai** key, retain that key variable and explicitly set `GLM_BASE_URL=https://api.z.ai/api/paas/v4`. An explicit base URL wins over both defaults; the full `/chat/completions` endpoint is also accepted and normalized. Do **not** mix a mainland key with an international URL or vice versa. Some Z.ai account types may require a different endpoint or model entitlement: use the exact URL and model permitted by your account. `GLM_MODEL` sets chat; `GLM_CODING_MODEL` sets Agent coding (defaults to GLM-4.7), and `GLM_VISION_MODEL` sets vision. Secrets and runtime settings must be present in the running deployment, not only in a local `.env`.

Image generation uses `GLM_IMAGE_API_KEY` if present, otherwise `ZAI_API_KEY` or `GLM_API_KEY`. It uses `GLM_IMAGE_BASE_URL` if set, otherwise the GLM chat base URL. `GLM_IMAGE_MODEL` defaults to `cogview-4`; if your Z.ai account exposes a different image model, set its **actual enabled image model ID** (for example `glm-image` if your account supports it). This endpoint calls `/images/generations` and requires image-generation entitlement/credits separate from chat. The Admin image connection test now makes a **real, potentially billable image request**; a chat or catalog response does not establish image-generation access.

At `/admin/ai`, check the active model source and base URL. A saved `system_settings/ai_provider` configuration takes priority over the environment, as does a saved `system_settings/image_provider` image configuration. Change the saved configuration explicitly if it points to an obsolete endpoint/key; do not silently overwrite it or erase existing administrator choices. Also check any explicitly selected per-chat model or managed-provider route if traffic is going elsewhere. Test a short Chat request, an Agent source-file request, then the image connection test/image-generation request. Authentication or model errors require correcting the real gateway, key, model ID, or account entitlement; no fallback should be mistaken for GLM success.

Agent can save source files for non-static languages (for example Python or Rust) without pretending to compile or publish them. MATRIX's built-in preview/publisher supports **static HTML/CSS/JavaScript only**: an isolated runtime/host is needed to run, validate, or deploy server or native applications. For a non-static project, request source files without a publish/preview action.
