# Browser-side SAP request signing

## Source and purpose

Source: [Lakr233/AssppWeb PR #89](https://github.com/Lakr233/AssppWeb/pull/89), revision `835a54dd773caeaa6ad6b342d5cde1bf3e6ceb29`.

Authentication requests carry `X-Apple-ActionSignature` over their exact UTF-8 body bytes. Apple's CommerceKit/CoreFP code runs inside a browser Web Worker using the PR's patched Unicorn TCI WebAssembly engine. Credentials remain in the browser while signing, and the authentication request reaches Apple through the browser's TLS tunnel.

## Implementation

- [SAP modules](../frontend/src/apple/sap/) load the engine and Apple assets, perform setup, and sign request bodies.
- [Authentication](../frontend/src/apple/authenticate.ts) signs each attempt, including verification-code retries.
- [Backend asset service](../backend/src/services/sapAssets.ts) verifies Apple's binary digests and extracts the x86_64 slices. The backend serves these public assets through [SAP asset routes](../backend/src/routes/sapAssets.ts).
- The Dockerfile prebakes the assets. Browser caching, background preparation, and inline progress reduce repeated setup work.
- [Engine build script](../frontend/scripts/unicorn-wasm-patch/build.sh) regenerates the vendored JavaScript and WASM from the checked-in patch and C glue.

## Fork adjustments

- Allow `s.mzstatic.com` and `fpinit.itunes.apple.com` through Wisp for the SAP certificate and setup exchange.
- Reject pending worker operations on crashes, undecodable messages, failed message delivery, or a two-minute request timeout. Terminate the worker to release its WASM heap.
- Bound signer setup to two minutes after the Apple assets load, including the WASM download and key exchange. Retry with a fresh worker after failure.
- Reuse the signer for the same device and replace it when switching devices. Cleanup covers failed setup and WASM downloads.
- Resolve build-script output paths relative to the script directory.
- Preserve [Node 24](node-24-container.md). Keep the valid Docker workflow platform configuration rather than the PR's malformed YAML edit.
- Correct credential-boundary comments and import ordering in the touched signer integration.

## Regression coverage and validation

Relevant tests:

- [Worker lifecycle](../frontend/tests/sap/client.test.ts): reuse, crashes, timeouts, cleanup, retries, and device switching.
- [Authentication](../frontend/tests/apple/authenticate.test.ts): exact request bytes across a verification-code retry.
- [Bag parsing](../frontend/tests/apple/bag.test.ts): SAP endpoints and integer protocol versions.
- [Wisp proxy](../backend/tests/wsProxy.test.ts): allowed setup hosts and rejected lookalike hosts.
- [Mach-O loading](../frontend/tests/sap/machImage.test.ts): the PR's loader tests.

Validation recorded on 2026-09-22: 10 isolated worker lifecycle scenarios passed with mocked transport and workers. Hostname checks, TypeScript syntax, WASM validity, JSON parsing, shell syntax, and whitespace checks passed. These checks establish control-flow and artifact validity, not successful execution of Apple's signing handshake.

Full Vitest suites and production builds remain unverified because local dependencies were unavailable. Real-account authentication, 2FA, and physical-iPhone verification remain pending. The PR's manual machine test checks the expected signing failure without key exchange and does not establish successful end-to-end authentication.

## Maintenance

Preserve these worker and allowlist fixes when updating the upstream patch. Regenerate the WASM through the build script when changing its engine source. Keep the SAP bag fields when integrating [download recovery](owned-app-download-recovery.md).
