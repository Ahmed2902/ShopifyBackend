# Stride external MCP clients

Stride exposes one standards-oriented remote MCP server at `/mcp`. ChatGPT and Claude are the first supported external clients, but the server is intentionally not coupled to either vendor.

## Architecture

```text
Shopify + Meta + TikTok + Stride Pixel
                |
                v
      Stride intelligence/read models
                |
                v
        Stride remote MCP server
                |
      +---------+---------+
      |         |         |
      v         v         v
   ChatGPT    Claude    future MCP clients
```

The MCP protocol, OAuth resource, scopes, tools, and business rules remain identical regardless of which LLM client connects. Do not add vendor-specific business logic to tool handlers. Client-specific compatibility should be limited to standards metadata or transport compatibility and covered by tests.

## Remote MCP endpoint

Use the deployed Stride API origin followed by:

```text
/mcp
```

Example:

```text
https://api.example.com/mcp
```

The server must be reachable over HTTPS from the external client's cloud infrastructure.

## Authentication

Stride uses OAuth authorization-code flow with PKCE S256.

The remote MCP resource publishes:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

OAuth properties:

- resource-bound access tokens
- `mcp:read` scope for MCP tool access
- `offline_access` for refresh-token issuance
- authorization-code PKCE S256
- dynamic client registration for public clients
- Client ID Metadata Document (CIMD) support
- issuer-bound authorization responses (`iss`) so clients can safely use stable metadata identities
- rotating refresh tokens
- store membership revalidation on every MCP request

Every published Stride tool also declares standard OAuth `securitySchemes` and mirrors them under `_meta.securitySchemes` for older client compatibility.

## Protocol compatibility

Preferred protocol:

```text
2026-07-28
```

This is MCP's stateless protocol era and is ideal for horizontally scaled remote servers.

Stride also accepts the handshake-era Streamable HTTP revisions currently needed for broader client compatibility:

```text
2025-11-25
2025-06-18
2025-03-26
```

For handshake-era clients, Stride negotiates the requested supported revision during `initialize`. The server remains stateless and does not require sticky application sessions for its read-only V1 tool surface.

Do not branch business behavior based on protocol version. Version handling belongs only in the MCP transport/protocol layer.

## ChatGPT

Stride is designed to work as a custom remote MCP app/connector in ChatGPT.

Current setup flow:

1. Deploy Stride so the API origin is publicly reachable through HTTPS.
2. In an eligible ChatGPT workspace/account, enable developer mode for custom MCP apps.
3. Create/add a custom app and use the Stride `/mcp` URL.
4. Choose OAuth authentication when prompted.
5. Complete Stride's authorization screen and select the store to connect.
6. Let ChatGPT scan the Stride tool catalog.
7. Enable the Stride app for a chat and test prompts such as:
   - `How is my store performing?`
   - `Why did revenue fall this week?`
   - `Which campaigns need attention?`
   - `What does Stride recommend I do next?`

ChatGPT OAuth compatibility is deliberately standards-based:

- protected-resource metadata is published
- authorization-server metadata is published
- PKCE S256 is required
- refresh access is advertised
- CIMD is supported
- issuer-bound authorization responses are advertised
- each MCP tool declares OAuth `securitySchemes`

No OpenAI API key is required by Stride for this integration. ChatGPT is the MCP client and pays/handles its own model execution.

## Claude

Stride is also designed to work as a Claude custom connector using remote MCP.

Current Claude setup flow:

1. Deploy Stride over public HTTPS.
2. In Claude, open `Customize -> Connectors`.
3. Add a custom connector.
4. Enter the Stride `/mcp` URL.
5. Complete OAuth authentication when Claude asks to connect.
6. Enable the connector for a conversation.
7. Ask the same Stride business questions you would ask in ChatGPT.

For Team/Enterprise Claude organizations, an Owner may need to add the custom connector at the organization level before individual users authenticate it.

No Anthropic API key is required by Stride when Claude itself is acting as the remote MCP client. The separate Anthropic Messages API MCP connector is also compatible with the same endpoint when the API caller supplies an OAuth access token.

## Adding another LLM client

A new client should not require new Stride business tools.

Before adding provider-specific code, verify whether the client already supports:

1. remote Streamable HTTP MCP
2. one of Stride's supported protocol revisions
3. OAuth protected-resource discovery
4. authorization-code + PKCE
5. public-client DCR or CIMD
6. bearer access tokens

If all are supported, the client should connect to `/mcp` without a backend fork.

If compatibility work is required, keep it isolated to one of these layers:

- MCP protocol negotiation
- OAuth discovery/registration metadata
- transport response formatting
- optional tool-descriptor compatibility metadata

Never duplicate Stride analytics, attribution, billing, recommendation, privacy, or authorization logic for a specific LLM vendor.

## Production verification

Run repository CI first. Then, after deployment, run:

```bash
BASE_URL=https://your-api.example.com \
MCP_ACCESS_TOKEN=<oauth-issued-token> \
npm run smoke:mcp-release
```

Optionally set:

```bash
MCP_EXPECT_STORE_ID=<expected-store-uuid>
```

The smoke test verifies OAuth-bound store context, MCP discovery, all required tools, recommendations, privacy boundaries, and protected resources.

After that, perform one real connection from each supported client UI because client-side connector behavior can change independently of Stride.

## External references

- OpenAI: Building remote MCP servers / custom ChatGPT apps: https://developers.openai.com/api/docs/mcp
- OpenAI: MCP/Apps authentication: https://developers.openai.com/plugins/build/auth
- Claude: Remote MCP custom connectors: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Anthropic API MCP connector: https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector
- MCP protocol versions: https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions
