import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';
import { logger } from '../lib/logger.js';

function requestPath(req: Request) {
  return req.originalUrl.split('?')[0] ?? req.path;
}

function isMcpRequest(req: Request) {
  return req.path === '/mcp' || requestPath(req) === '/mcp';
}

function isMcpOAuthTokenRequest(req: Request) {
  return requestPath(req) === '/oauth/token';
}

function isMcpClientRegistrationRequest(req: Request) {
  return requestPath(req) === '/oauth/register';
}

function jsonRpcId(req: Request): string | number | null {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : null;
}

function isJsonParseError(error: unknown) {
  return (
    error instanceof SyntaxError &&
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === 400 &&
    'body' in error
  );
}

function sendMcpError(
  req: Request,
  res: Response,
  status: number,
  code: number,
  message: string,
  data?: unknown,
) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({
    jsonrpc: '2.0',
    id: jsonRpcId(req),
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function oauthErrorCode(error: AppError) {
  switch (error.code) {
    case 'MCP_INVALID_GRANT':
      return 'invalid_grant';
    case 'MCP_INVALID_CLIENT':
      return 'invalid_client';
    case 'MCP_INVALID_SCOPE':
      return 'invalid_scope';
    default:
      return 'invalid_request';
  }
}

function sendOAuthError(res: Response, status: number, code: string, description: string) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: code, error_description: description });
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} was not found`,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (isMcpRequest(req)) {
    if (isJsonParseError(error)) {
      sendMcpError(req, res, 400, -32700, 'Parse error');
      return;
    }
    if (error instanceof ZodError) {
      sendMcpError(req, res, 400, -32602, 'Invalid params', {
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
      return;
    }
    if (error instanceof AppError) {
      sendMcpError(req, res, error.statusCode, -32000, error.message, {
        code: error.code,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return;
    }

    logger.error({ err: error, method: req.method, path: req.path }, 'Unhandled MCP request error');
    sendMcpError(req, res, 500, -32603, 'Internal error');
    return;
  }

  if (isMcpOAuthTokenRequest(req)) {
    if (error instanceof ZodError || isJsonParseError(error)) {
      sendOAuthError(res, 400, 'invalid_request', 'The token request is malformed.');
      return;
    }
    if (error instanceof AppError) {
      sendOAuthError(res, error.statusCode, oauthErrorCode(error), error.message);
      return;
    }
    logger.error({ err: error, method: req.method, path: req.path }, 'Unhandled MCP OAuth token error');
    sendOAuthError(res, 500, 'server_error', 'The authorization server could not complete the request.');
    return;
  }

  if (isMcpClientRegistrationRequest(req)) {
    if (error instanceof ZodError || isJsonParseError(error)) {
      sendOAuthError(res, 400, 'invalid_client_metadata', 'The client metadata is malformed.');
      return;
    }
    if (error instanceof AppError) {
      const code =
        error.code === 'MCP_INVALID_CLIENT_METADATA' ||
        error.code === 'MCP_INVALID_REDIRECT_URI' ||
        error.code === 'MCP_INVALID_CLIENT'
          ? 'invalid_client_metadata'
          : 'invalid_request';
      sendOAuthError(res, error.statusCode, code, error.message);
      return;
    }
    logger.error({ err: error, method: req.method, path: req.path }, 'Unhandled MCP client registration error');
    sendOAuthError(res, 500, 'server_error', 'The authorization server could not complete the request.');
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.flatten(),
      },
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  logger.error({ err: error, method: req.method, path: req.path }, 'Unhandled request error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
};
