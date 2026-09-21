import type { RequestHandler, Response } from 'express';
import { MCP_READ_SCOPE, mcpIssuer, verifyMcpAccessToken } from './mcp-oauth.utils.js';

function challenge() {
  const metadata = new URL('/.well-known/oauth-protected-resource/mcp', `${mcpIssuer()}/`).toString();
  return `Bearer resource_metadata="${metadata}", scope="${MCP_READ_SCOPE}"`;
}

function unauthorized(res: Response, message: string) {
  res.setHeader('WWW-Authenticate', challenge());
  res.status(401).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32001, message },
  });
}

export const requireMcpAuth: RequestHandler = async (req, res, next) => {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    unauthorized(res, 'Stride MCP authentication required');
    return;
  }
  const bearer = authorization.slice('Bearer '.length).trim();
  if (!bearer) {
    unauthorized(res, 'Stride MCP authentication required');
    return;
  }
  try {
    const token = await verifyMcpAccessToken(bearer);
    if (!token.scopes.includes(MCP_READ_SCOPE)) {
      unauthorized(res, 'Stride MCP token is missing mcp:read');
      return;
    }
    req.context.userId = token.userId;
    req.context.storeId = token.storeId;
    next();
  } catch {
    unauthorized(res, 'Invalid or expired Stride MCP access token');
  }
};
