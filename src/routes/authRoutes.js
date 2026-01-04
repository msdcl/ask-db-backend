import express from 'express';
import * as authController from '../controllers/authController.js';
import * as authValidators from '../validators/authValidators.js';
import { validate } from '../middleware/validation.js';
import { authenticate } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

router.post(
  '/register',
  authLimiter,
  authValidators.registerValidator,
  validate,
  authController.register
);

router.post(
  '/login',
  authLimiter,
  authValidators.loginValidator,
  validate,
  authController.login
);

router.post(
  '/refresh',
  authValidators.refreshTokenValidator,
  validate,
  authController.refresh
);

router.post('/logout', authController.logout);

router.get('/me', authenticate, authController.getCurrentUser);

export default router;
