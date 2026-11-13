# GitHub OAuth callback deployment check

## Root cause

Both `/api/github/connect` and `/api/github/callback` built local redirects using `new URL('/chat?...', req.url)`. Behind the production HTTPS reverse proxy, `req.url` can be the upstream `http://localhost:10000` URL. The callback checked `isGithubConfigured()` **before** checking whether it was a valid OAuth callback: directly visiting an unconfigured callback therefore issued precisely `Location: http://localhost:10000/chat?mode=agent&github=not-configured`. The connect route and its fallback OAuth `redirect_uri` had the same untrusted-request-origin problem.

The routes now resolve an explicit `NEXT_PUBLIC_APP_URL` and validate an optional `GITHUB_OAUTH_CALLBACK_URL` against its exact `/api/github/callback` path. In production a missing, local/private, insecure, or mismatched setting returns HTTP 503 with a configuration code; neither `Host` nor forwarded headers supply a redirect origin. Localhost is accepted only for requests to local development under non-production NODE_ENV, with a matching local callback override (or no override).

## Required operator configuration

- Bind `matrix.thamjj13.top` to the actual Render/Firebase service, with TLS and `/api/github/*` forwarded unchanged. Set `NEXT_PUBLIC_APP_URL=https://matrix.thamjj13.top` at both build and runtime.
- Set `GITHUB_OAUTH_CALLBACK_URL=https://matrix.thamjj13.top/api/github/callback` at runtime (Render and App Hosting blueprints now provide this public, non-secret value). Remove any conflicting override in the hosting dashboard.
- In the **GitHub OAuth App** settings, register the **exact** Authorization callback URL `https://matrix.thamjj13.top/api/github/callback`. This GitHub-side setting cannot be changed or confirmed from this repository.
- Set server-only `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and a random `GITHUB_TOKEN_ENCRYPTION_KEY` of at least 32 characters. Firebase Admin credentials must also be configured for the MATRIX session and encrypted connection document. Do not put secrets in `NEXT_PUBLIC_` variables.
- `GITHUB_CALLBACK_URL`, `GITHUB_REDIRECT_URI`, `APP_URL`, and `NEXTAUTH_URL` are **not read** by this integration. `GITHUB_OAUTH_CALLBACK_URL` is the actual callback override; `NEXT_PUBLIC_APP_URL` is the authoritative production origin.

## Runtime checks after deployment

1. `curl -sSI https://matrix.thamjj13.top/api/github/callback` uses HEAD, so use GET instead: `curl -sS -D - -o /dev/null https://matrix.thamjj13.top/api/github/callback`. Expect HTTP 303 and `Location: https://matrix.thamjj13.top/chat?mode=agent&github=invalid_callback` (unless a proxy intercepts the route). No connection should be created.
2. Sign in, open Agent chat, click **Continue with GitHub**. In the `302` to `https://github.com/login/oauth/authorize`, check `redirect_uri=https://matrix.thamjj13.top/api/github/callback`, a random `state`, and Secure HttpOnly state cookies.
3. Complete and separately deny consent; check `connected`/`denied` on the public MATRIX host, verify the intended `/chat/<id>` thread is restored, and confirm `/api/github/status` reports a connection only after a successful exchange.
4. Try missing/mismatched/expired state and missing config; check public-origin error handling and that no Location points to localhost. If these tests fail only on the deployed service, check its runtime environment and reverse proxy/CDN configuration.

The checkout cannot reach the production host or use its GitHub OAuth App, production Firebase session or encrypted-token store. Automated tests cover the route's real logic with an internal localhost request URL, but a real GitHub consent flow and production HTTP headers remain deployment checks.
