import { Router } from 'express';
import { mcpRateLimit } from '../../middleware/rate-limit.middleware.js';
import { requireMcpAuth } from './mcp-auth.middleware.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-11-25';

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export const mcpRouter = Router();

mcpRouter.post('/mcp', mcpRateLimit, requireMcpAuth, (req, res) => {
  res.setHeader('cache-control', 'no-store');
  const request = req.body as {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  };
  const id = request?.id ?? null;
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    res.status(400).json(rpcError(id, -32600, 'Invalid Request'));
    return;
  }
  if (request.id === undefined) {
    res.status(202).end();
    return;
  }

  if (request.method === 'server/discover') {
    res.status(200).json(
      rpcResult(id, {
        resultType: 'complete',
        supportedVersions: [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION],
        capabilities: { tools: {}, resources: {} },
        instructions:
          'Stride MCP authorization is active. Advisor tools and resources are exposed by the MCP server layer.',
        ttlMs: 3600000,
        cacheScope: 'public',
      }),
    );
    return;
  }
  if (request.method === 'initialize') {
    res.status(200).json(
      rpcResult(id, {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'Stride', version: '1.0.0' },
      }),
    );
    return;
  }
  if (request.method === 'ping') {
    res.status(200).json(rpcResult(id, {}));
    return;
  }
  if (request.method === 'tools/list') {
    res.status(200).json(rpcResult(id, { tools: [] }));
    return;
  }
  if (request.method === 'resources/list' || request.method === 'resources/templates/list') {
    res.status(200).json(
      rpcResult(id, request.method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] }),
    );
    return;
  }

  res.status(200).json(rpcError(id, -32601, `Method not found: ${request.method}`));
});

mcpRouter.get('/mcp', mcpRateLimit, requireMcpAuth, (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json(rpcError(null, -32600, 'Stride MCP uses stateless POST requests on this endpoint.'));
});

mcpRouter.delete('/mcp', mcpRateLimit, requireMcpAuth, (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json(rpcError(null, -32600, 'Stride MCP uses stateless POST requests on this endpoint.'));
});
