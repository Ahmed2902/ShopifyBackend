# MCP client compatibility matrix

This file is the release-facing compatibility matrix for Stride's single remote MCP endpoint.

| Capability | ChatGPT custom MCP | Claude remote MCP | Generic remote MCP client |
| --- | --- | --- | --- |
| HTTPS `/mcp` endpoint | Supported | Supported | Required |
| Streamable HTTP JSON responses | Supported | Supported | Supported |
| OAuth protected-resource discovery | Supported | Supported | Supported |
| Authorization code + PKCE S256 | Supported | Supported | Supported |
| Public-client DCR | Supported fallback | Supported | Supported |
| Client ID Metadata Document (CIMD) | Supported | Accepted when client uses it | Supported |
| Refresh tokens via `offline_access` | Supported | Supported | Supported |
| Per-tool OAuth `securitySchemes` | Published | Harmless/portable | Published |
| MCP 2026-07-28 stateless era | Preferred | Supported when client negotiates it | Supported |
| MCP 2025-11-25 compatibility path | Supported stateless fallback | Supported stateless fallback | Supported stateless fallback |
| MCP 2025-06-18 compatibility path | Supported stateless fallback | Supported stateless fallback | Supported stateless fallback |
| MCP 2025-03-26 compatibility path | Supported stateless fallback | Supported stateless fallback | Supported stateless fallback |

Client names are validation targets, not branches in the business layer. Shopify, advertising, Pixel, attribution, billing, privacy, and recommendation behavior remain client-independent.

The legacy compatibility path intentionally remains stateless: Stride's read-only V1 surface does not create sticky application sessions merely to serve older Streamable HTTP clients. Protocol/version handling stays isolated in the transport layer.

## Request-path performance and failure-boundary invariants

- Immutable tool descriptors, OAuth security metadata, tool-name lookup, and resource-URI lookup are created once at module load instead of rebuilt or linearly scanned for every MCP call.
- Unsupported provider/action combinations and missing paid-media detail identifiers are rejected before billing or provider reads.
- Broad paid-media search performs one active-plan read for the normal Pro/multi-channel path. An Essentials store with an already selected provider is resolved directly from that plan state. Only the temporary no-selection state falls back to per-provider read-only checks, and those checks run concurrently.
- Independent decision-setting reads run concurrently.
- Advisor search remains deliberately bounded to at most 100 candidates per requested surface and executes independent surface reads concurrently; it is not an unbounded database or full-text search endpoint.
- Unexpected provider/database failures are logged internally and reduced to a generic external MCP error; only client-actionable non-5xx `AppError` messages cross the external advisor boundary.
- Response serialization is bounded by the MCP controller's context-size guard, and the external advisor remains read-only.

Any future LLM client should first be tested against this same standards contract. Add provider-specific transport metadata only when the provider demonstrably requires it; do not fork Stride's tools or business logic per model vendor.
