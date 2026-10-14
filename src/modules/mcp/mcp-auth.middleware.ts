import type { RequestHandler, Response } from 'express';
import { mcpOAuthRepository } from './mcp-oauth.repository.js';
import { MCP_READ_SCOPE, mcpIssuer, verifyMcpAccessToken } from './mcp-oauth.utils.js';

function challenge(error?: 'invalid_token' | 'insufficient_scope') {
  const metadata = new URL('/.well-known/oauth-protected-resource/mcp', `${mcpIssuer()}/`).toString();
  return `Bearer resource_metadata="${metadata}", scope="${MCP_READ_SCOPE}"${error ? `, error="${error}"` : ''}`;
}

function unauthorized(res: Response, message: string, error?: 'invalid_token' | 'insufficient_scope') {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('WWW-Authenticate', challenge(error));
  res.status(error === 'insufficient_scope' ? 403 : 401).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32001, message },
  });
}

export const requireMcpAuth: RequestHandler = async (req, res, next) => {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    unauthorized(res, 'Metrico MCP authentication required');
    return;
  }
  const bearer = authorization.slice('Bearer '.length).trim();
  if (!bearer) {
    unauthorized(res, 'Metrico MCP authentication required');
    return;
  }
  let token;
  try {
    token = await verifyMcpAccessToken(bearer);
  } catch {
    unauthorized(res, 'Invalid or expired Metrico MCP access token', 'invalid_token');
    return;
  }
  if (!token.scopes.includes(MCP_READ_SCOPE)) {
    unauthorized(res, 'Metrico MCP token is missing mcp:read', 'insufficient_scope');
    return;
  }

  try {
    // Authorization can change after a 15-minute MCP access token is issued. Re-check the
    // store membership on every MCP request so removing a merchant/user from a store revokes
    // advisor access immediately rather than waiting for token expiry.
    const membership = await mcpOAuthRepository.hasStoreAccess(token.userId, token.storeId);
    if (!membership) {
      unauthorized(res, 'Metrico MCP store access is no longer available', 'invalid_token');
      return;
    }

    req.context.userId = token.userId;
    req.context.storeId = token.storeId;
    req.context.role = membership.role;
  } catch {
    // A database outage does not invalidate the client's OAuth grant. Keep the
    // connection retryable instead of asking the merchant to authorize again.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '5');
    res.status(503).json({
      jsonrpc: '2.0', id: null,
      error: { code: -32603, message: 'Metrico store access could not be checked. Retry shortly.' },
    });
    return;
  }
  next();
};
