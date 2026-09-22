import type { Request, Response } from 'express';
import { z } from 'zod';
import { mcpOAuthService, type McpOAuthService } from './mcp-oauth.service.js';

const pkceVerifier = z.string().min(43).max(128).regex(/^[A-Za-z0-9._~-]+$/);
const pkceChallenge = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/);
const publicUrl = z.string().max(2048).url();

const authorizeSchema = z.object({
  client_id: z.string().min(1).max(2048),
  redirect_uri: publicUrl,
  response_type: z.string().min(1).max(32),
  state: z.string().max(2048).optional(),
  scope: z.string().max(1024).optional(),
  resource: publicUrl.optional(),
  code_challenge: pkceChallenge,
  code_challenge_method: z.string().min(1).max(16),
});

const registerSchema = z.object({
  client_name: z.string().max(120).optional(),
  redirect_uris: z.array(publicUrl).min(1).max(20),
  token_endpoint_auth_method: z.enum(['none']).optional(),
  grant_types: z.array(z.string().max(64)).max(10).optional(),
  response_types: z.array(z.string().max(64)).max(10).optional(),
});

const requestParamsSchema = z.object({ requestId: z.string().uuid() });
const approvalSchema = z.object({ storeId: z.string().uuid() });
const tokenSchema = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token']),
  client_id: z.string().min(1).max(2048),
  code: z.string().max(2048).optional(),
  redirect_uri: publicUrl.optional(),
  code_verifier: pkceVerifier.optional(),
  refresh_token: z.string().max(2048).optional(),
  resource: publicUrl.optional(),
});

function noStore(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
}

export class McpOAuthController {
  constructor(private readonly service: McpOAuthService = mcpOAuthService) {}

  protectedResourceMetadata = (_req: Request, res: Response) => {
    res.setHeader('cache-control', 'public, max-age=300');
    res.status(200).json(this.service.protectedResourceMetadata());
  };

  authorizationServerMetadata = (_req: Request, res: Response) => {
    res.setHeader('cache-control', 'public, max-age=300');
    res.status(200).json({
      ...this.service.authorizationServerMetadata(),
      // RFC 9207 issuer identification lets generic MCP clients use stable client metadata
      // documents (including ChatGPT CIMD) without callback-specific client registration.
      authorization_response_iss_parameter_supported: true,
    });
  };

  register = async (req: Request, res: Response) => {
    noStore(res);
    res.status(201).json(await this.service.registerClient(registerSchema.parse(req.body)));
  };

  authorize = async (req: Request, res: Response) => {
    noStore(res);
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
    noStore(res);
    const { requestId } = requestParamsSchema.parse(req.params);
    res.status(200).json(await this.service.authorizationRequest(req.context.userId!, requestId));
  };

  approve = async (req: Request, res: Response) => {
    noStore(res);
    const { requestId } = requestParamsSchema.parse(req.params);
    const { storeId } = approvalSchema.parse(req.body);
    res.status(200).json({
      redirectUrl: await this.service.approve(req.context.userId!, requestId, storeId),
    });
  };

  deny = async (req: Request, res: Response) => {
    noStore(res);
    const { requestId } = requestParamsSchema.parse(req.params);
    res.status(200).json({
      redirectUrl: await this.service.deny(req.context.userId!, requestId),
    });
  };

  token = async (req: Request, res: Response) => {
    noStore(res);
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
