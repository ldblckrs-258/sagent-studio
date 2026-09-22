import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

/**
 * Injects the strict Content-Security-Policy meta tag into the production build only.
 *
 * Keys live in browser memory, so script injection is the primary threat and
 * script-src 'self' is the containment control that must not be relaxed. The dev
 * server is deliberately excluded: @vitejs/plugin-react injects an inline module
 * preamble for Fast Refresh, which a strict script-src would block.
 *
 * connect-src cannot enumerate runtime-configured provider origins (the user adds
 * arbitrary OpenAI-compatible endpoints), so it allows https plus localhost. That is
 * a deliberate trade-off; script-src stays locked. A public deployment should
 * generate the CSP server-side from the configured provider allowlist and send
 * frame-ancestors / X-Frame-Options as headers, which a meta tag cannot enforce.
 *
 * Sandbox workers: a same-origin http(s) worker does not inherit this document
 * policy; its policy comes from its own response headers (HTML §7.1.7). Vite emits
 * the runner chunks as separate same-origin assets, so they run without a document
 * CSP and may use eval/WASM, which is why script-src needs no 'unsafe-eval'. The
 * worker therefore also has page-equivalent network egress and can open IndexedDB.
 * That is an accepted residual risk recorded in the core chat engine plan; the
 * vault key never enters a worker and only explicit tool inputs cross the bridge.
 * A production host may optionally serve the worker assets with a
 * `connect-src 'self'` response header; that is host-dependent and not a gate.
 */
function cspPlugin(): Plugin {
  const policy = [
    "default-src 'self'",
    // `blob:` lets the model-artifact preview serve its document and its
    // externalized scripts from app-created blob URLs. A blob URL can only be
    // minted by same-origin script that is already executing, so this does not
    // turn injected text into code the way 'unsafe-inline' would; that directive
    // must never be added. The artifact frame itself is sandboxed without
    // `allow-same-origin`, so it cannot read app storage or the parent DOM.
    "script-src 'self' blob:",
    "frame-src 'self' blob:",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");

  return {
    name: "inject-csp-meta",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  };
}

/**
 * TypeSafe's endpoint does not send CORS headers, so a direct browser call is
 * blocked at the preflight. The client defaults to a same-origin `/typesafe`
 * path in the browser; dev and preview proxy it to the hosted API. A static
 * production host must provide the same `/typesafe` proxy, or the user sets an
 * explicit base URL in the TypeSafe settings.
 */
const TYPESAFE_PROXY_TARGET = "https://api.typesafe.ai";

const typesafeProxy = {
  "/typesafe": {
    target: TYPESAFE_PROXY_TARGET,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/typesafe/, ""),
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    babel({ presets: [reactCompilerPreset()] }),
    cspPlugin(),
  ],
  server: {
    watch: {
      ignored: ["**/plans/**"],
    },
    proxy: typesafeProxy,
  },
  preview: {
    proxy: typesafeProxy,
  },
  worker: {
    format: "es",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
