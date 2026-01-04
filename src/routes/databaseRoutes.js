import express from 'express';
import * as databaseController from '../controllers/databaseController.js';
import * as queryValidators from '../validators/queryValidators.js';
import { validate } from '../middleware/validation.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

router.get('/databases', authenticate, databaseController.getDatabases);

router.get(
  '/databases/:databaseName/tables',
  authenticate,
  queryValidators.databaseParamValidator,
  validate,
  databaseController.getTables
);

router.get(
  '/databases/:databaseName/tables/:tableName/schema',
  authenticate,
  authorize('admin'),
  queryValidators.tableParamValidator,
  validate,
  databaseController.getTableSchema
);

router.get(
  '/databases/:databaseName/tables/:tableName/data',
  authenticate,
  authorize('admin'),
  queryValidators.tableParamValidator,
  queryValidators.paginationValidator,
  validate,
  databaseController.getTableData
);

router.post(
  '/databases/:databaseName/index',
  authenticate,
  authorize('admin'),
  queryValidators.databaseParamValidator,
  validate,
  databaseController.indexDatabase
);

export default router;
