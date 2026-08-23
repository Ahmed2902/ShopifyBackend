import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { authController } from './auth.controller.js';
import { authService } from './auth.service.js';
import { googleCallback, googleRedirect } from './google.oauth.js';

export const authRouter = Router();

authRouter.post('/register', authController.register);
authRouter.post('/login', authController.login);
authRouter.post('/verify-email', authController.verifyEmail);
authRouter.post('/resend-verification', authController.resendVerification);
authRouter.post('/forgot-password', authController.forgotPassword);
authRouter.post('/reset-password', authController.resetPassword);
authRouter.get('/google/start', googleRedirect);
authRouter.get('/google/callback', googleCallback(authService));
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', requireAuth, authController.me);
