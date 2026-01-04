import express from 'express';
import * as databaseConfigController from '../controllers/databaseConfigController.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { body, param } from 'express-validator';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Add database configuration (admin only)
router.post(
  '/',
  requireAdmin,
  [
    body('databaseName').trim().notEmpty().withMessage('Database name is required'),
    body('host').trim().notEmpty().withMessage('Host is required'),
    body('port').isInt({ min: 1, max: 65535 }).withMessage('Valid port number is required'),
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required'),
    body('databaseType').optional().trim(),
    body('description').optional().trim(),
  ],
  validate,
  databaseConfigController.addDatabase
);

// Get all databases for user's organization
router.get('/', databaseConfigController.getDatabases);

// Get tables for a specific database
router.get(
  '/:databaseId/tables',
  [param('databaseId').isInt().withMessage('Valid database ID is required')],
  validate,
  databaseConfigController.getDatabaseTables
);

// Index database (fetch and store table schemas) - admin only
router.post(
  '/:databaseId/index',
  requireAdmin,
  [param('databaseId').isInt().withMessage('Valid database ID is required')],
  validate,
  databaseConfigController.indexDatabase
);

// Get table schema with metadata
router.get(
  '/:databaseId/tables/:tableName/schema',
  [
    param('databaseId').isInt().withMessage('Valid database ID is required'),
    param('tableName').trim().notEmpty().withMessage('Table name is required'),
  ],
  validate,
  databaseConfigController.getTableSchema
);

// Update table description (admin only)
router.put(
  '/tables/:tableSchemaId/description',
  requireAdmin,
  [
    param('tableSchemaId').isInt().withMessage('Valid table schema ID is required'),
    body('description').trim().notEmpty().withMessage('Description is required'),
  ],
  validate,
  databaseConfigController.updateTableDescription
);

// Update column description (admin only)
router.put(
  '/tables/:tableSchemaId/columns/:columnName/description',
  requireAdmin,
  [
    param('tableSchemaId').isInt().withMessage('Valid table schema ID is required'),
    param('columnName').trim().notEmpty().withMessage('Column name is required'),
    body('description').trim().notEmpty().withMessage('Description is required'),
  ],
  validate,
  databaseConfigController.updateColumnDescription
);

// Update database configuration (admin only)
router.put(
  '/:databaseId',
  requireAdmin,
  [
    param('databaseId').isInt().withMessage('Valid database ID is required'),
    body('description').optional().trim(),
    body('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
  ],
  validate,
  databaseConfigController.updateDatabase
);

// Delete database configuration (admin only)
router.delete(
  '/:databaseId',
  requireAdmin,
  [param('databaseId').isInt().withMessage('Valid database ID is required')],
  validate,
  databaseConfigController.deleteDatabase
);

export default router;
