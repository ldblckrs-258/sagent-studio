---
type: research
date: 2026-10-25
topic: Vercel external rewrites as a same-origin proxy for Replicate
---

# Vercel external rewrites as a same-origin proxy

## Summary

A plain `vercel.json` with external rewrites can proxy `/replicate` and `/replicate-files` with no new dependency and no serverless function. The proxied request timeout is 120 s to first byte, so `Prefer: wait=60` fits. Header pass-through, body size limits, and billing class for rewrites are not documented and must be checked on a preview deployment.

## Verified live (2026-10-25)

- `https://sagent-studio.vercel.app/typesafe/x` returns 404, and the repo has no `vercel.json`.
- `https://sagent-studio.vercel.app/some/deep/path` returns 404 with `x-vercel-error: NOT_FOUND`. The app has no client router, so this does not need a SPA catch-all for the playground.

## Findings

1. **Headers.** Vercel adds `x-real-ip`, `x-forwarded-for`, `x-forwarded-host`, and `x-forwarded-proto` on external rewrites ([rewrites](https://vercel.com/docs/routing/rewrites), [request headers](https://vercel.com/docs/headers/request-headers)). Pass-through of `Authorization`, `Prefer`, `Content-Type`, and multipart bodies is not documented. UNVERIFIED.
2. **Size limits.** No documented request or response size limit for external rewrites. The 4.5 MB limit is documented only for Functions ([FUNCTION_PAYLOAD_TOO_LARGE](https://vercel.com/docs/errors/FUNCTION_PAYLOAD_TOO_LARGE)). UNVERIFIED.
3. **Timeout.** The proxied request timeout is 120 s on all plans and applies to rewrites with an external destination; the error is `ROUTER_EXTERNAL_TARGET_ERROR` ([limits](https://vercel.com/docs/limits), [changelog](https://vercel.com/changelog/cdn-origin-timeout-increased-to-two-minutes)).
4. **Caching.** Projects created on or after 2026-04-06 honour upstream `Cache-Control` on external rewrites by default ([changelog](https://vercel.com/changelog/vercels-cdn-now-respects-cache-control-headers-from-external-origins-by-default)). Requests with `Authorization` or a non-GET method are not cached ([CDN cache](https://vercel.com/docs/caching/cdn-cache)). The documented opt-out is the `x-vercel-enable-rewrite-caching: 0` header on the source path ([rewrites](https://vercel.com/docs/routing/rewrites)).
5. **Ordering.** The filesystem is checked first, then rewrites in array order ([vercel.json](https://vercel.com/docs/project-configuration/vercel-json#rewrites)).
6. **vercel.json vs vercel.ts.** Both are supported; `vercel.ts` needs `@vercel/config`. Only one config file per project ([project configuration](https://vercel.com/docs/project-configuration)).
7. **Security and billing.** The destination host is fixed, so host hijack is not the concern; the concern is an open relay that bills the project for bandwidth (Fast Data Transfer, [CDN usage](https://vercel.com/docs/manage-cdn-usage)). Restricting the path to `v1/...` and a WAF rate-limit rule (one rule on Hobby, [rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)) are cheap mitigations. Constraining wildcard parameters is recommended ([security guide](https://vercel.com/kb/guide/enhancing-security-for-redirects-and-rewrites)).

## Snippet (without SPA catch-all)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/replicate/:path*", "destination": "https://api.replicate.com/:path*" },
    { "source": "/replicate-files/:path*", "destination": "https://replicate.delivery/:path*" }
  ],
  "headers": [
    {
      "source": "/replicate/:path*",
      "headers": [{ "key": "x-vercel-enable-rewrite-caching", "value": "0" }]
    }
  ]
}
```

## Unresolved questions

1. Do `Authorization`, `Prefer`, `Content-Type`, and multipart bodies pass through unchanged? Test on a preview deployment.
2. Is there a request or response size limit on external rewrites? Test a multi-MB upload and download.
3. Does the caching opt-out header apply as documented? Check `x-vercel-cache` on a response.
