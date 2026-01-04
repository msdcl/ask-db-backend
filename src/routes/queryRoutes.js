import express from 'express';
import * as queryController from '../controllers/queryController.js';
import * as queryValidators from '../validators/queryValidators.js';
import { validate } from '../middleware/validation.js';
import { authenticate } from '../middleware/auth.js';
import { queryLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

router.post(
  '/execute',
  authenticate,
  queryLimiter,
  queryValidators.executeQueryValidator,
  validate,
  queryController.executeNaturalQuery
);

router.get(
  '/history',
  authenticate,
  queryValidators.paginationValidator,
  validate,
  queryController.getQueryHistory
);

export default router;
