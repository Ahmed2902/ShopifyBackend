import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import {
  issueCsrfToken,
  requireCsrf,
  requireTrustedOrigin,
} from '../../middleware/csrf.middleware.js';
import {
  authRateLimit,
  csrfRateLimit,
  emailRateLimit,
  loginRateLimit,
  refreshRateLimit,
} from '../../middleware/rate-limit.middleware.js';
import { authController } from './auth.controller.js';
import { authService } from './auth.service.js';
import { googleCallback, googleRedirect } from './google.oauth.js';

export const authRouter = Router();

authRouter.get('/csrf', requireTrustedOrigin, csrfRateLimit, issueCsrfToken);
authRouter.post('/register', authRateLimit, authController.register);
authRouter.post('/login', loginRateLimit, authController.login);
authRouter.post('/verify-email', authRateLimit, authController.verifyEmail);
authRouter.post('/resend-verification', emailRateLimit, authController.resendVerification);
authRouter.post('/forgot-password', emailRateLimit, authController.forgotPassword);
authRouter.post('/reset-password', authRateLimit, authController.resetPassword);
authRouter.get('/google/start', authRateLimit, googleRedirect);
authRouter.get('/google/callback', googleCallback(authService));
authRouter.post('/refresh', requireCsrf, refreshRateLimit, authController.refresh);
authRouter.post('/logout', requireCsrf, refreshRateLimit, authController.logout);
authRouter.get('/me', requireAuth, authController.me);
