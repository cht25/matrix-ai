"use client";

// =============================================================================
// Native shell — the `next/navigation` surface, implemented on the shared
// QORVYNA route table.
//
// WHY THIS EXISTS
//   The Tauri app must run the SAME components as the website. Those components
//   reach the router through `next/link` and `next/navigation`. Only the
//   *pages* in `src/app/**` are Next.js server code; every screen the app
//   renders (chat, devices, settings, models, automations, mirror…) is a client
//   component that talks to the backend exclusively over `/api/*` + Firebase
//   REST/Auth. The native shell therefore needs exactly two things from Next:
//   a router and a link. This file is that router.
//
// URL CONTRACT — identical to the web app
//   `/chat`, `/chat/<id>?mode=agent&new=…`, `/devices`, `/settings` … every
//   path, query key and parameter is the same string the website uses, so a
//   link written for the web works unchanged in the app (and vice versa).
//
// History is real: `usePathname`, `useSearchParams`, `push`, `replace`,
// `back`, `forward` all map to the platform history stack.
// =============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------------------
// Router state
// ---------------------------------------------------------------------------

export type NativeRouter = {
  /** Current pathname, always starting with "/". */
  pathname: string;
  /** Current query string without the "?" ("" when there is none). */
  search: string;
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string) => void;
};

type LocationState = { pathname: string; search: string; key: number };

/** Split an app href into the parts the router tracks. */
export function parseHref(href: string): { pathname: string; search: string; hash: string } {
  const raw = String(href ?? "").trim();
  if (!raw) return { pathname: "/", search: "", hash: "" };
  let rest = raw;
  // Absolute URLs to this app (e.g. https://host/chat) keep only their path.
  try {
    if (/^https?:\/\//i.test(rest)) {
      const parsed = new URL(rest);
      rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    /* not a URL — treat as a path */
  }
  const hashIndex = rest.indexOf("#");
  const hash = hashIndex >= 0 ? rest.slice(hashIndex) : "";
  if (hashIndex >= 0) rest = rest.slice(0, hashIndex);
  const queryIndex = rest.indexOf("?");
  const pathname = queryIndex >= 0 ? rest.slice(0, queryIndex) : rest;
  const search = queryIndex >= 0 ? rest.slice(queryIndex + 1) : "";
  return { pathname: pathname.startsWith("/") ? pathname : `/${pathname}`, search, hash };
}

/** Read the current location from the platform (or a sensible default). */
function readLocation(): LocationState {
  if (typeof window === "undefined") return { pathname: "/", search: "", key: 0 };
  const parsed = parseHref(`${window.location.pathname}${window.location.search}`);
  return { pathname: parsed.pathname || "/", search: parsed.search, key: 0 };
}

const RouterContext = createContext<NativeRouter | null>(null);

/**
 * Drives the shell's history. `initialPath` is the route the app opens on
 * (the native shell passes the platform's start URL, e.g. "/chat").
 */
export function RouterProvider({ initialPath = "/", children }: { initialPath?: string; children: ReactNode }) {
  const start = useMemo(() => {
    const parsed = parseHref(initialPath);
    return { pathname: parsed.pathname, search: parsed.search, key: 0 };
  }, [initialPath]);
  const [location, setLocation] = useState<LocationState>(start);
  const [historyVersion, setHistoryVersion] = useState(0);

  const applyLocation = useCallback((pathname: string, search: string, mode: "push" | "replace") => {
    if (typeof window !== "undefined") {
      const target = `${pathname}${search ? `?${search}` : ""}`;
      try {
        if (mode === "push") window.history.pushState({ qorvyna: true }, "", target);
        else window.history.replaceState({ qorvyna: true }, "", target);
      } catch {
        /* history unavailable (rare webview restriction) — in-memory routing continues */
      }
    }
    setLocation((prev) => ({ pathname, search, key: prev.key + 1 }));
  }, []);

  const push = useCallback(
    (href: string) => {
      const parsed = parseHref(href);
      applyLocation(parsed.pathname, parsed.search, "push");
    },
    [applyLocation],
  );
  const replace = useCallback(
    (href: string) => {
      const parsed = parseHref(href);
      applyLocation(parsed.pathname, parsed.search, "replace");
    },
    [applyLocation],
  );
  const back = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
      return;
    }
    setLocation((prev) => ({ ...prev, key: prev.key - 1 }));
  }, []);
  const forward = useCallback(() => {
    if (typeof window !== "undefined") window.history.forward();
  }, []);
  const refresh = useCallback(() => setHistoryVersion((value) => value + 1), []);

  // The platform's Back button / Alt+Left / Cmd+[ must move the app, not leave it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      const next = readLocation();
      setLocation((prev) => ({ ...next, key: prev.key + 1 }));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const router = useMemo<NativeRouter>(
    () => ({ ...location, push, replace, back, forward, refresh, prefetch: () => {} }),
    [location, push, replace, back, forward, refresh],
  );
  void historyVersion; // refresh() intentionally re-renders consumers

  return <RouterContext.Provider value={router}>{children}</RouterContext.Provider>;
}

function useNativeRouter(): NativeRouter {
  const router = useContext(RouterContext);
  if (!router) throw new Error("QORVYNA native router is not mounted (RouterProvider is missing).");
  return router;
}

// ---------------------------------------------------------------------------
// `next/navigation` surface
// ---------------------------------------------------------------------------

export function useRouter() {
  const router = useNativeRouter();
  return useMemo(
    () => ({
      push: router.push,
      replace: router.replace,
      back: router.back,
      forward: router.forward,
      refresh: router.refresh,
      prefetch: router.prefetch,
    }),
    [router],
  );
}

export function usePathname(): string {
  return useNativeRouter().pathname;
}

/** Same contract as Next's `ReadonlyURLSearchParams` for the methods used here. */
export function useSearchParams(): URLSearchParams {
  const { search } = useNativeRouter();
  // A fresh object per search string mirrors Next's identity behaviour.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function useParams<T extends Record<string, string | string[]> = Record<string, string>>(): T {
  const pathname = usePathname();
  return useMemo(() => matchDynamicSegments(pathname) as T, [pathname]);
}

/**
 * Path parameters for the dynamic routes the app actually has:
 *   /chat/[id] · /projects/[id] · /courses/[slug] · /scams/[slug] · /s/[slug]
 * The pattern list mirrors `src/app/**` — a new dynamic page must be added here.
 */
const DYNAMIC_ROUTES: Array<{ pattern: string[]; keys: string[] }> = [
  { pattern: ["chat", ":id"], keys: ["id"] },
  { pattern: ["projects", ":id"], keys: ["id"] },
  { pattern: ["courses", ":slug"], keys: ["slug"] },
  { pattern: ["scams", ":slug"], keys: ["slug"] },
  { pattern: ["certificate", "verify", ":id"], keys: ["id"] },
  { pattern: ["certificate", "print", ":id"], keys: ["id"] },
];

export function matchDynamicSegments(pathname: string): Record<string, string> {
  const parts = pathname.split("/").filter(Boolean);
  for (const route of DYNAMIC_ROUTES) {
    if (route.pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < route.pattern.length; i += 1) {
      const pattern = route.pattern[i];
      if (pattern.startsWith(":")) {
        try {
          params[route.keys[route.pattern.indexOf(pattern)] ?? pattern.slice(1)] = decodeURIComponent(parts[i]);
        } catch {
          params[pattern.slice(1)] = parts[i];
        }
        continue;
      }
      if (pattern !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return params;
  }
  return {};
}

/**
 * `redirect()` from a client component. In Next this throws a navigation
 * signal; here it navigates and returns, which is what a client component does
 * with it anyway.
 */
export function redirect(href: string): never {
  if (typeof window !== "undefined") {
    const parsed = parseHref(href);
    window.location.replace(`${parsed.pathname}${parsed.search ? `?${parsed.search}` : ""}`);
  }
  // Never returns: the browser is already navigating.
  throw new Error(`QORVYNA_REDIRECT:${href}`);
}

export function notFound(): never {
  throw new Error("QORVYNA_NOT_FOUND");
}

// ---------------------------------------------------------------------------
// `next/link`
// ---------------------------------------------------------------------------

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  replace?: boolean;
  scroll?: boolean;
  prefetch?: boolean;
  children?: ReactNode;
};

/**
 * Anchor that routes inside the app. It renders a real `<a href>`, so
 * middle-click / copy-link / accessibility all keep working, and only
 * intercepts a plain left click.
 */
export function Link({ href, replace, scroll: _scroll, prefetch: _prefetch, onClick, children, ...rest }: LinkProps) {
  const router = useNativeRouter();
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (rest.target && rest.target !== "_self") return;
        event.preventDefault();
        if (replace) router.replace(href);
        else router.push(href);
      }}
    >
      {children}
    </a>
  );
}

export default Link;
