import type { Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import {
  emailRequestSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.schema.js';
import { authService, type AuthService } from './auth.service.js';
import {
  clearRefreshCookie,
  REFRESH_COOKIE_NAME,
  sanitizeUserAgent,
  setRefreshCookie,
} from './auth.utils.js';

function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
}

export class AuthController {
  constructor(private readonly service: AuthService) {}

  register = async (req: Request, res: Response) => {
    noStore(res);
    const result = await this.service.register(registerSchema.parse(req.body));
    res.status(201).json(result);
  };

  login = async (req: Request, res: Response) => {
    noStore(res);
    const result = await this.service.login(
      loginSchema.parse(req.body),
      sanitizeUserAgent(req.get('user-agent')),
    );
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ user: result.user, accessToken: result.accessToken });
  };

  verifyEmail = async (req: Request, res: Response) => {
    noStore(res);
    res.status(200).json(await this.service.verifyEmail(verifyEmailSchema.parse(req.body)));
  };

  resendVerification = async (req: Request, res: Response) => {
    noStore(res);
    res
      .status(202)
      .json(await this.service.resendVerification(emailRequestSchema.parse(req.body)));
  };

  forgotPassword = async (req: Request, res: Response) => {
    noStore(res);
    res
      .status(202)
      .json(await this.service.requestPasswordReset(emailRequestSchema.parse(req.body)));
  };

  resetPassword = async (req: Request, res: Response) => {
    noStore(res);
    const result = await this.service.resetPassword(resetPasswordSchema.parse(req.body));
    clearRefreshCookie(res);
    res.status(200).json(result);
  };

  refresh = async (req: Request, res: Response) => {
    noStore(res);
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    if (!refreshToken) throw new AppError('Refresh session required', 401, 'INVALID_SESSION');

    const result = await this.service.rotateRefreshSession(
      refreshToken,
      sanitizeUserAgent(req.get('user-agent')),
    );
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ user: result.user, accessToken: result.accessToken });
  };

  logout = async (req: Request, res: Response) => {
    noStore(res);
    await this.service.revokeRefreshSession(
      req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined,
    );
    clearRefreshCookie(res);
    res.status(204).send();
  };

  me = async (req: Request, res: Response) => {
    noStore(res);
    res.status(200).json({ user: await this.service.getCurrentUser(req.context.userId!) });
  };
}

export const authController = new AuthController(authService);
