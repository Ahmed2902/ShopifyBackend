import { Router } from 'express';
import { requireMcpAuth } from './mcp-auth.middleware.js';
import { mcpController } from './mcp.controller.js';

export const mcpRouter = Router();

mcpRouter.post('/mcp', requireMcpAuth, mcpController.post);
mcpRouter.get('/mcp', requireMcpAuth, mcpController.methodNotAllowed);
mcpRouter.delete('/mcp', requireMcpAuth, mcpController.methodNotAllowed);
