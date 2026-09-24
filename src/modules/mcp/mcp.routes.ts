import { Router } from 'express';
import { mcpRateLimit } from '../../middleware/rate-limit.middleware.js';
import { requireActiveSubscription } from '../billing/billing.middleware.js';
import { requireMcpAuth } from './mcp-auth.middleware.js';
import { mcpController } from './mcp.controller.js';
import { requireMcpToolEntitlement } from './mcp-entitlement.middleware.js';

export const mcpRouter = Router();

mcpRouter.post(
  '/mcp',
  mcpRateLimit,
  requireMcpAuth,
  requireActiveSubscription,
  requireMcpToolEntitlement,
  mcpController.post,
);
mcpRouter.get(
  '/mcp',
  mcpRateLimit,
  requireMcpAuth,
  requireActiveSubscription,
  mcpController.methodNotAllowed,
);
mcpRouter.delete(
  '/mcp',
  mcpRateLimit,
  requireMcpAuth,
  requireActiveSubscription,
  mcpController.methodNotAllowed,
);
