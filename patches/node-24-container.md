# Node 24 container images

## Source and purpose

This fork uses `node:24-alpine` for the frontend build, backend build, SAP asset extraction, and runtime stages in [Dockerfile](../Dockerfile).

The fork-local source commit is `8be1e7d8cdcf99b9541332ce79ec886630802814` (`Bump to node:24-alpine`). This patch is independent of the browser SAP signer and download recovery patches.

## Integration requirements

- Keep all Node image stages on the same major version when importing upstream Dockerfile changes.
- Build stages use `$BUILDPLATFORM`. The runtime installs dependencies for the target architecture, including native modules.
- Published image targets are `linux/amd64` and `linux/arm64`.
- The SAP asset extraction stage also uses Node 24. Its behavior is documented in [browser SAP signing](browser-sap-signing.md).

## Validation

The Dockerfile's Node image versions were checked during patch integration on 2026-09-22. Container builds and runtime verification remain pending.

When validating this patch, build the Dockerfile for the supported targets and check both the backend startup and frontend delivery. Local Compose overrides and deployment data are user-owned.
