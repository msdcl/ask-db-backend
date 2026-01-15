import { body, param, query } from 'express-validator';

const MAX_INSTRUCTION_WORDS = 50;

const countWords = (text) => text.trim().split(/\s+/).filter(Boolean).length;

export const executeQueryValidator = [
  body('query')
    .notEmpty()
    .withMessage('Query is required')
    .isString()
    .withMessage('Query must be a string')
    .isLength({ min: 3, max: 1000 })
    .withMessage('Query must be between 3 and 1000 characters'),
  body('instruction')
    .optional({ nullable: true })
    .isString()
    .withMessage('Instruction must be a string')
    .custom((value) => {
      if (!value || !value.trim()) {
        return true;
      }
      if (countWords(value) > MAX_INSTRUCTION_WORDS) {
        throw new Error(`Instruction must be ${MAX_INSTRUCTION_WORDS} words or less`);
      }
      return true;
    }),
  body('databaseConfigId')
    .notEmpty()
    .withMessage('Database config ID is required')
    .isInt({ min: 1 })
    .withMessage('Database config ID must be a valid integer'),
];

export const databaseParamValidator = [
  param('databaseName')
    .notEmpty()
    .withMessage('Database name is required')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Invalid database name'),
];

export const tableParamValidator = [
  param('databaseName')
    .notEmpty()
    .withMessage('Database name is required')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Invalid database name'),
  param('tableName')
    .notEmpty()
    .withMessage('Table name is required')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Invalid table name'),
];

export const paginationValidator = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 1000 })
    .withMessage('Limit must be between 1 and 1000'),
  query('offset')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Offset must be a positive number'),
];
