import type { Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import { loginSchema, registerSchema } from './auth.schema.js';
import type { AuthService } from './auth.service.js';
import {
  clearRefreshCookie,
  REFRESH_COOKIE_NAME,
  sanitizeUserAgent,
  setRefreshCookie,
} from './auth.utils.js';

export class AuthController {
  constructor(private readonly service: AuthService) {}

  private sessionMetadata(req: Request) {
    return { userAgent: sanitizeUserAgent(req.get('user-agent')) };
  }

  register = async (req: Request, res: Response) => {
    const input = registerSchema.parse(req.body);
    const result = await this.service.register(input, this.sessionMetadata(req));
    setRefreshCookie(res, result.refreshToken);
    res.status(201).json({ user: result.user, accessToken: result.accessToken });
  };

  login = async (req: Request, res: Response) => {
    const input = loginSchema.parse(req.body);
    const result = await this.service.login(input, this.sessionMetadata(req));
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ user: result.user, accessToken: result.accessToken });
  };

  refresh = async (req: Request, res: Response) => {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    if (!refreshToken) throw new AppError('Refresh session required', 401, 'INVALID_SESSION');

    const result = await this.service.rotateRefreshSession(refreshToken, this.sessionMetadata(req));
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ user: result.user, accessToken: result.accessToken });
  };

  logout = async (req: Request, res: Response) => {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    await this.service.revokeRefreshSession(refreshToken);
    clearRefreshCookie(res);
    res.status(204).send();
  };

  me = async (req: Request, res: Response) => {
    const user = await this.service.getCurrentUser(req.context.userId!);
    res.status(200).json({ user });
  };
}
