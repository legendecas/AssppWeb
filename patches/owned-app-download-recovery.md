# Download recovery for owned apps

## Source and purpose

Source: [Lakr233/AssppWeb PR #90](https://github.com/Lakr233/AssppWeb/pull/90), revision `951528ef72d42686f5af16b74e41fffbc37cda35`.

An owned app can return an empty `songList` from `volumeStoreDownloadProduct`, followed by an empty HTTP 500 from redownload. This patch recovers through version-pinned dispatch requests and the bag's `updateProduct` endpoint.

## Implementation

[downloadProduct.ts](../frontend/src/apple/downloadProduct.ts) shares request, redirect, cookie, and recovery handling across downloads, version lists, and version metadata lookup.

1. Request volumeStore with the caller's version when supplied.
2. For an empty or unavailable result, or failureType `5002`, resolve the bag's dispatch endpoints.
3. Preserve the caller's explicit version. Otherwise, look up an iOS version in the account's storefront.
4. Try redownload. An empty HTTP 500 or recoverable result can use updateProduct with the same version and session.
5. Validate the returned app ID, bundle identifier, and requested version before accepting the result.

Token errors `2034` and `2042` and license error `9610` remain explicit failures. The public catalog lookup receives no account headers or cookies. Account-bearing requests stay inside the browser's TLS tunnel.

## Fork adjustments

- Try the `ios`, `iphone`, and `ipad` catalogs in order when an app or usable iOS offer is absent. Keep the account's storefront throughout.
- Use `buyParams` when the offer's external version ID is missing or empty. Reject catalog bundle mismatches and report exhaustion after all three catalogs.
- Preserve explicitly selected versions through every recovery endpoint and skip catalog lookup for those requests.
- Merge download URLs into the bag result alongside the [SAP setup endpoints](browser-sap-signing.md), including the default-auth-URL path.
- Add `uclient-api.itunes.apple.com` to Wisp's exact hostname allowlist while retaining the SAP setup hosts.
- Keep fork maintenance guidance in the external work guide. The local `AGENTS.md` is unchanged by this patch.

## Regression coverage and validation

- [Download protocol tests](../frontend/tests/apple/downloadProduct.test.ts): catalog recovery and exhaustion, public lookup isolation, pinned versions, metadata mismatches, token/license errors, redirects, and cookie rotation.
- [Bag tests](../frontend/tests/apple/bag.test.ts): root and nested download/SAP fields, root-field precedence, and auth URL fallback.
- [Wisp tests](../backend/tests/wsProxy.test.ts): the catalog hostname and rejected lookalikes.

Validation recorded on 2026-09-22: 29 isolated protocol checks, seven hostname checks, TypeScript syntax checks for nine changed files, and whitespace checks passed. The isolated protocol checks use mocked Apple responses and JSON in place of plist serialization. They cover request control flow and response validation, not Apple's live download service.

Both project test commands stopped at `vitest: command not found`. Full Vitest suites, production builds, and real-account download/install verification remain pending.

## Maintenance

Preserve catalog recovery and SAP bag coexistence when updating this patch. Keep `externalVersionId` for volumeStore and `appExtVrsId` for dispatch requests. Validate that an explicit version remains unchanged, the resulting IPA is the intended iOS app, and downloaded SINF/metadata remain usable during real-account verification.
