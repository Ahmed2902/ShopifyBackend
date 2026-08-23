import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { AuthController } from './auth.controller.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { googleCallback, googleRedirect } from './google.oauth.js';

const repository = new AuthRepository();
const service = new AuthService(repository);
const controller = new AuthController(service);

export const authRouter = Router();

authRouter.post('/register', controller.register);
authRouter.post('/login', controller.login);
authRouter.get('/google/start', googleRedirect);
authRouter.get('/google/callback', googleCallback(service));
authRouter.post('/refresh', controller.refresh);
authRouter.post('/logout', controller.logout);
authRouter.get('/me', requireAuth, controller.me);
