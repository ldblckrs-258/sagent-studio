import type { ProxyOptions } from "vite";

export const REPLICATE_API_PROXY_KEY = "^/replicate/v1/";

export const REPLICATE_FILES_PROXY_KEY =
  "^/replicate-files/(?:_|[a-z0-9-]{1,32})/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\\.(?:png|jpe?g|webp|gif|avif)$";

export const REPLICATE_R2_PROXY_KEY =
  "^/replicate-r2/[0-9a-f]{32}/provider-outputs/[0-9a-f-]{36}/[0-9a-f-]{36}\\?(?:[^#]*&)?X-Amz-Signature=[^&#]+[^#]*$";

export const HARDENED_FILE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "content-security-policy": "sandbox; default-src 'none'",
  "content-disposition": "attachment",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
};

interface ProxyRoute {
  target: string;
  path: string;
}

export function replicateFilesRoute(url: string): ProxyRoute | null {
  const match = /^\/replicate-files\/(_|[a-z0-9-]{1,32})(\/.+)$/.exec(url);
  if (!match) return null;
  const [, sub, path] = match;
  return {
    target:
      sub === "_"
        ? "https://replicate.delivery"
        : `https://${sub}.replicate.delivery`,
    path,
  };
}

export function replicateR2Route(url: string): ProxyRoute | null {
  const match = /^\/replicate-r2\/([0-9a-f]{32})(\/.+)$/.exec(url);
  if (!match) return null;
  const [, account, path] = match;
  return {
    target: `https://ai-gateway-outputs.${account}.r2.cloudflarestorage.com`,
    path,
  };
}

function hardenedRoutedProxy(
  route: (url: string) => ProxyRoute | null,
): ProxyOptions["configure"] {
  return (proxy) => {
    const web = proxy.web.bind(proxy) as unknown as (
      req: { url?: string },
      res: unknown,
      options: object,
    ) => void;
    Object.defineProperty(proxy, "web", {
      configurable: true,
      writable: true,
      value: (req: { url?: string }, res: unknown, options: object = {}) => {
        const next = route(req.url ?? "");
        if (!next) return web(req, res, options);
        req.url = next.path;
        return web(req, res, { ...options, target: next.target });
      },
    });
    proxy.on("proxyRes", (proxyRes) => {
      delete proxyRes.headers["set-cookie"];
      Object.assign(proxyRes.headers, HARDENED_FILE_HEADERS);
    });
  };
}

export const replicateProxy: Record<string, ProxyOptions> = {
  [REPLICATE_API_PROXY_KEY]: {
    target: "https://api.replicate.com",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/replicate/, ""),
  },
  [REPLICATE_FILES_PROXY_KEY]: {
    target: "https://replicate.delivery",
    changeOrigin: true,
    configure: hardenedRoutedProxy(replicateFilesRoute),
  },
  [REPLICATE_R2_PROXY_KEY]: {
    target: "https://r2.cloudflarestorage.com",
    changeOrigin: true,
    configure: hardenedRoutedProxy(replicateR2Route),
  },
};
