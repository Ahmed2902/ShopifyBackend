import type { Request, Response } from 'express';
import {
  mcpProtocolService,
  type McpHeaders,
  type McpProtocolService,
  type McpRpcRequest,
} from './mcp-protocol.service.js';

const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;

function requestHeaders(req: Request): McpHeaders {
  return {
    protocolVersion: req.header('mcp-protocol-version') ?? undefined,
    method: req.header('mcp-method') ?? undefined,
    name: req.header('mcp-name') ?? undefined,
  };
}

function invalidRequest() {
  return {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: 'Invalid Request' },
  };
}

export class McpController {
  constructor(private readonly protocol: McpProtocolService = mcpProtocolService) {}

  post = async (req: Request, res: Response) => {
    res.setHeader('cache-control', 'no-store');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json(invalidRequest());
      return;
    }

    const result = await this.protocol.handle(
      req.context.storeId!,
      req.body as McpRpcRequest,
      requestHeaders(req),
    );
    if (result.body === null) {
      res.status(result.status).end();
      return;
    }

    const serialized = JSON.stringify(result.body);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MCP_RESPONSE_BYTES) {
      res.status(200).json({
        jsonrpc: '2.0',
        id: (req.body as McpRpcRequest).id ?? null,
        error: {
          code: -32002,
          message:
            'Stride MCP response exceeded the safe context budget. Narrow the time window, page size, entity type, or use a detail tool.',
        },
      });
      return;
    }

    res.status(result.status).type('application/json').send(serialized);
  };

  methodNotAllowed = (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Stride MCP uses stateless POST requests on this endpoint.' },
    });
  };
}

export const mcpController = new McpController();
