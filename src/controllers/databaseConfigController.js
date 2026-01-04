import { databaseConfigService } from '../services/databaseConfigService.js';
import { logger } from '../utils/logger.js';

export const addDatabase = async (req, res, next) => {
  try {
    const { databaseName, host, port, username, password, databaseType, description } = req.body;
    const userId = req.user.id;
    const organizationId = req.user.organizationId;

    const result = await databaseConfigService.addDatabase(userId, organizationId, {
      databaseName,
      host,
      port,
      username,
      password,
      databaseType,
      description,
    });

    logger.info(`Database added by user ${userId}:`, { databaseName });

    res.status(201).json({
      success: true,
      message: 'Database added successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getDatabases = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;

    const databases = await databaseConfigService.getOrganizationDatabases(organizationId);

    res.status(200).json({
      success: true,
      data: databases,
    });
  } catch (error) {
    next(error);
  }
};

export const getDatabaseTables = async (req, res, next) => {
  try {
    const { databaseId } = req.params;
    const organizationId = req.user.organizationId;

    const tables = await databaseConfigService.getDatabaseTables(parseInt(databaseId), organizationId);

    res.status(200).json({
      success: true,
      data: tables,
    });
  } catch (error) {
    next(error);
  }
};

export const indexDatabase = async (req, res, next) => {
  try {
    const { databaseId } = req.params;
    const userId = req.user.id;
    const organizationId = req.user.organizationId;

    const result = await databaseConfigService.indexDatabase(parseInt(databaseId), organizationId, userId);

    logger.info(`Database indexed by user ${userId}:`, { databaseId });

    res.status(200).json({
      success: true,
      message: result.message,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getTableSchema = async (req, res, next) => {
  try {
    const { databaseId, tableName } = req.params;
    const organizationId = req.user.organizationId;

    const schema = await databaseConfigService.getTableSchema(parseInt(databaseId), tableName, organizationId);

    res.status(200).json({
      success: true,
      data: schema,
    });
  } catch (error) {
    next(error);
  }
};

export const updateTableDescription = async (req, res, next) => {
  try {
    const { tableSchemaId } = req.params;
    const { description } = req.body;
    const organizationId = req.user.organizationId;

    const result = await databaseConfigService.updateTableDescription(
      parseInt(tableSchemaId),
      description,
      organizationId
    );

    res.status(200).json({
      success: true,
      message: 'Table description updated successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const updateColumnDescription = async (req, res, next) => {
  try {
    const { tableSchemaId, columnName } = req.params;
    const { description } = req.body;
    const organizationId = req.user.organizationId;

    const result = await databaseConfigService.updateColumnDescription(
      parseInt(tableSchemaId),
      columnName,
      description,
      organizationId
    );

    res.status(200).json({
      success: true,
      message: 'Column description updated successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const updateDatabase = async (req, res, next) => {
  try {
    const { databaseId } = req.params;
    const { description, isActive } = req.body;
    const organizationId = req.user.organizationId;

    const result = await databaseConfigService.updateDatabaseConfig(
      parseInt(databaseId),
      organizationId,
      { description, isActive }
    );

    res.status(200).json({
      success: true,
      message: 'Database updated successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteDatabase = async (req, res, next) => {
  try {
    const { databaseId } = req.params;
    const organizationId = req.user.organizationId;

    const result = await databaseConfigService.deleteDatabase(parseInt(databaseId), organizationId);

    res.status(200).json({
      success: true,
      message: 'Database deleted successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
