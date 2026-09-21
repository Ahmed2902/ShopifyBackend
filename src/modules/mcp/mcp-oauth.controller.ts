import type { Request, Response } from 'express';
import { z } from 'zod';
import { mcpOAuthService, type McpOAuthService } from './mcp-oauth.service.js';

const authorizeSchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  response_type: z.string().min(1),
  state: z.string().max(2048).optional(),
  scope: z.string().max(1024).optional(),
  resource: z.string().url().optional(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.string().min(1),
});

const registerSchema = z.object({
  client_name: z.string().max(120).optional(),
  redirect_uris: z.array(z.string().url()).min(1).max(20),
  token_endpoint_auth_method: z.enum(['none']).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

const requestParamsSchema = z.object({ requestId: z.string().uuid() });
const approvalSchema = z.object({ storeId: z.string().uuid() });
const tokenSchema = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token']),
  client_id: z.string().min(1),
  code: z.string().optional(),
  redirect_uri: z.string().url().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  resource: z.string().url().optional(),
});

export class McpOAuthController {
  constructor(private readonly service: McpOAuthService = mcpOAuthService) {}

  protectedResourceMetadata = (_req: Request, res: Response) => {
    res.setHeader('cache-control', 'public, max-age=300');
    res.status(200).json(this.service.protectedResourceMetadata());
  };

  authorizationServerMetadata = (_req: Request, res: Response) => {
    res.setHeader('cache-control', 'public, max-age=300');
    res.status(200).json(this.service.authorizationServerMetadata());
  };

  register = async (req: Request, res: Response) => {
    res.status(201).json(await this.service.registerClient(registerSchema.parse(req.body)));
  };

  authorize = async (req: Request, res: Response) => {
    const input = authorizeSchema.parse(req.query);
    const location = await this.service.beginAuthorization({
      clientId: input.client_id,
      redirectUri: input.redirect_uri,
      responseType: input.response_type,
      state: input.state,
      scope: input.scope,
      resource: input.resource,
      codeChallenge: input.code_challenge,
      codeChallengeMethod: input.code_challenge_method,
    });
    res.redirect(302, location);
  };

  authorizationRequest = async (req: Request, res: Response) => {
    const { requestId } = requestParamsSchema.parse(req.params);
    res.status(200).json(await this.service.authorizationRequest(req.context.userId!, requestId));
  };

  approve = async (req: Request, res: Response) => {
    const { requestId } = requestParamsSchema.parse(req.params);
    const { storeId } = approvalSchema.parse(req.body);
    res.status(200).json({
      redirectUrl: await this.service.approve(req.context.userId!, requestId, storeId),
    });
  };

  deny = async (req: Request, res: Response) => {
    const { requestId } = requestParamsSchema.parse(req.params);
    res.status(200).json({
      redirectUrl: await this.service.deny(req.context.userId!, requestId),
    });
  };

  token = async (req: Request, res: Response) => {
    res.setHeader('cache-control', 'no-store');
    const input = tokenSchema.parse(req.body);
    if (input.grant_type === 'authorization_code') {
      res.status(200).json(
        await this.service.exchangeAuthorizationCode({
          code: input.code ?? '',
          clientId: input.client_id,
          redirectUri: input.redirect_uri ?? '',
          codeVerifier: input.code_verifier ?? '',
          resource: input.resource,
        }),
      );
      return;
    }
    res.status(200).json(
      await this.service.refresh({
        refreshToken: input.refresh_token ?? '',
        clientId: input.client_id,
        resource: input.resource,
      }),
    );
  };
}

export const mcpOAuthController = new McpOAuthController();
