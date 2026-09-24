import express, { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import {
  mcpClientRegistrationRateLimit,
  mcpOAuthRateLimit,
} from '../../middleware/rate-limit.middleware.js';
import { mcpOAuthController } from './mcp-oauth.controller.js';

export const mcpOAuthRouter = Router();

mcpOAuthRouter.get(
  '/.well-known/oauth-protected-resource',
  mcpOAuthController.protectedResourceMetadata,
);
mcpOAuthRouter.get(
  '/.well-known/oauth-protected-resource/mcp',
  mcpOAuthController.protectedResourceMetadata,
);
mcpOAuthRouter.get(
  '/.well-known/oauth-authorization-server',
  mcpOAuthController.authorizationServerMetadata,
);
mcpOAuthRouter.post('/oauth/register', mcpClientRegistrationRateLimit, mcpOAuthController.register);
mcpOAuthRouter.get('/oauth/authorize', mcpOAuthRateLimit, mcpOAuthController.authorize);
mcpOAuthRouter.post(
  '/oauth/token',
  mcpOAuthRateLimit,
  express.urlencoded({ extended: false, limit: '32kb' }),
  mcpOAuthController.token,
);

mcpOAuthRouter.get(
  '/v1/mcp/oauth/authorization-requests/:requestId',
  requireAuth,
  mcpOAuthController.authorizationRequest,
);
mcpOAuthRouter.post(
  '/v1/mcp/oauth/authorization-requests/:requestId/approve',
  requireAuth,
  mcpOAuthController.approve,
);
mcpOAuthRouter.post(
  '/v1/mcp/oauth/authorization-requests/:requestId/deny',
  requireAuth,
  mcpOAuthController.deny,
);
