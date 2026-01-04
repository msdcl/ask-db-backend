import { databaseService } from '../services/databaseService.js';
import { logger } from '../utils/logger.js';

export const getDatabases = async (req, res, next) => {
  try {
    const databases = await databaseService.getAvailableDatabases();

    res.status(200).json({
      success: true,
      data: { databases },
    });
  } catch (error) {
    next(error);
  }
};

export const getTables = async (req, res, next) => {
  try {
    const { databaseName } = req.params;

    const tables = await databaseService.getTablesInDatabase(databaseName);

    res.status(200).json({
      success: true,
      data: { tables },
    });
  } catch (error) {
    next(error);
  }
};

export const getTableSchema = async (req, res, next) => {
  try {
    const { databaseName, tableName } = req.params;

    const schema = await databaseService.getTableSchema(databaseName, tableName);

    res.status(200).json({
      success: true,
      data: { schema },
    });
  } catch (error) {
    next(error);
  }
};

export const getTableData = async (req, res, next) => {
  try {
    const { databaseName, tableName } = req.params;
    const { limit = 100, offset = 0 } = req.query;

    const result = await databaseService.getTableData(
      databaseName,
      tableName,
      parseInt(limit),
      parseInt(offset)
    );

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const indexDatabase = async (req, res, next) => {
  try {
    const { databaseName } = req.params;

    const result = await databaseService.indexDatabase(databaseName);

    logger.info('Database indexed', { databaseName });

    res.status(200).json({
      success: true,
      message: 'Database indexed successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
