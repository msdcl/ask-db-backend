import { database } from '../config/database.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import pg from 'pg';

const { Pool } = pg;

class DatabaseConfigService {
  async addDatabase(userId, organizationId, dbConfig) {
    const { databaseName, host, port, username, password, databaseType, description } = dbConfig;

    if (!databaseName || !host || !port || !username || !password) {
      throw new ValidationError('All database connection fields are required');
    }

    // Test connection to the database
    try {
      await this.testDatabaseConnection({ host, port, username, password, databaseName });
    } catch (error) {
      throw new ValidationError(`Database connection failed: ${error.message}`);
    }

    // Insert database configuration
    const result = await database.query(
      `INSERT INTO database_configurations
       (organization_id, database_name, host, port, username, password, database_type, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, database_name, host, port, database_type, description, is_active, created_at`,
      [organizationId, databaseName, host, port, username, password, databaseType || 'postgresql', description, userId]
    );

    logger.info(`Database configuration added: ${databaseName} for organization ${organizationId}`);
    return result.rows[0];
  }

  async testDatabaseConnection(config) {
    const pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.databaseName,
      connectionTimeoutMillis: 5000,
    });

    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      await pool.end();
      return true;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async getOrganizationDatabases(organizationId) {
    const result = await database.query(
      `SELECT id, database_name, host, port, database_type, description, is_active, created_at
       FROM database_configurations
       WHERE organization_id = $1 AND is_active = true
       ORDER BY database_name`,
      [organizationId]
    );

    return result.rows;
  }

  async getDatabaseTables(databaseConfigId, organizationId) {
    // Get database configuration
    const dbConfig = await this.getDatabaseConfig(databaseConfigId, organizationId);

    // Connect to the external database
    const pool = new Pool({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.username,
      password: dbConfig.password,
      database: dbConfig.database_name,
    });

    try {
      const result = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);

      await pool.end();
      return result.rows.map(row => row.table_name);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async getDatabaseConfig(databaseConfigId, organizationId) {
    const result = await database.query(
      `SELECT id, organization_id, database_name, host, port, username, password, database_type
       FROM database_configurations
       WHERE id = $1 AND organization_id = $2 AND is_active = true`,
      [databaseConfigId, organizationId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Database configuration not found');
    }

    return result.rows[0];
  }

  async indexDatabase(databaseConfigId, organizationId, userId) {
    const dbConfig = await this.getDatabaseConfig(databaseConfigId, organizationId);

    // Connect to the external database
    const pool = new Pool({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.username,
      password: dbConfig.password,
      database: dbConfig.database_name,
    });

    try {
      // Get all tables
      const tablesResult = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);

      const tables = tablesResult.rows;
      let indexedCount = 0;

      for (const table of tables) {
        const tableName = table.table_name;

        // Get table schema
        const schemaResult = await pool.query(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
          AND table_name = $1
          ORDER BY ordinal_position
        `, [tableName]);

        const schemaInfo = schemaResult.rows;

        // Check if table_schema already exists
        const existingSchema = await database.query(
          `SELECT id FROM table_schemas WHERE database_config_id = $1 AND table_name = $2`,
          [databaseConfigId, tableName]
        );

        if (existingSchema.rows.length === 0) {
          // Insert new table schema
          const insertResult = await database.query(
            `INSERT INTO table_schemas (database_config_id, table_name, schema_info)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [databaseConfigId, tableName, JSON.stringify(schemaInfo)]
          );

          const tableSchemaId = insertResult.rows[0].id;

          // Insert column metadata
          for (const column of schemaInfo) {
            await database.query(
              `INSERT INTO column_metadata (table_schema_id, column_name, data_type, is_nullable)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (table_schema_id, column_name) DO NOTHING`,
              [tableSchemaId, column.column_name, column.data_type, column.is_nullable === 'YES']
            );
          }

          indexedCount++;
        }
      }

      await pool.end();
      logger.info(`Indexed ${indexedCount} tables for database config ${databaseConfigId}`);

      return {
        totalTables: tables.length,
        indexedTables: indexedCount,
        message: `Successfully indexed ${indexedCount} new tables`
      };
    } catch (error) {
      await pool.end();
      logger.error('Database indexing failed:', error);
      throw error;
    }
  }

  async getTableSchema(databaseConfigId, tableName, organizationId) {
    // Verify database belongs to organization
    await this.getDatabaseConfig(databaseConfigId, organizationId);

    const result = await database.query(
      `SELECT ts.id, ts.table_name, ts.table_description, ts.schema_info,
              json_agg(
                json_build_object(
                  'column_name', cm.column_name,
                  'column_description', cm.column_description,
                  'data_type', cm.data_type,
                  'is_nullable', cm.is_nullable
                )
              ) as columns
       FROM table_schemas ts
       LEFT JOIN column_metadata cm ON ts.id = cm.table_schema_id
       WHERE ts.database_config_id = $1 AND ts.table_name = $2
       GROUP BY ts.id, ts.table_name, ts.table_description, ts.schema_info`,
      [databaseConfigId, tableName]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Table schema not found');
    }

    return result.rows[0];
  }

  async updateTableDescription(tableSchemaId, tableDescription, organizationId) {
    // Verify table belongs to organization
    const verifyResult = await database.query(
      `SELECT ts.id
       FROM table_schemas ts
       JOIN database_configurations dc ON ts.database_config_id = dc.id
       WHERE ts.id = $1 AND dc.organization_id = $2`,
      [tableSchemaId, organizationId]
    );

    if (verifyResult.rows.length === 0) {
      throw new NotFoundError('Table not found or access denied');
    }

    const result = await database.query(
      `UPDATE table_schemas
       SET table_description = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, table_name, table_description`,
      [tableDescription, tableSchemaId]
    );

    return result.rows[0];
  }

  async updateColumnDescription(tableSchemaId, columnName, columnDescription, organizationId) {
    // Verify table belongs to organization
    const verifyResult = await database.query(
      `SELECT ts.id
       FROM table_schemas ts
       JOIN database_configurations dc ON ts.database_config_id = dc.id
       WHERE ts.id = $1 AND dc.organization_id = $2`,
      [tableSchemaId, organizationId]
    );

    if (verifyResult.rows.length === 0) {
      throw new NotFoundError('Table not found or access denied');
    }

    const result = await database.query(
      `UPDATE column_metadata
       SET column_description = $1, updated_at = CURRENT_TIMESTAMP
       WHERE table_schema_id = $2 AND column_name = $3
       RETURNING id, column_name, column_description`,
      [columnDescription, tableSchemaId, columnName]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Column not found');
    }

    return result.rows[0];
  }

  async updateDatabaseConfig(databaseConfigId, organizationId, updates) {
    // Verify database belongs to organization
    await this.getDatabaseConfig(databaseConfigId, organizationId);

    const { description, isActive } = updates;
    const result = await database.query(
      `UPDATE database_configurations
       SET description = COALESCE($1, description),
           is_active = COALESCE($2, is_active),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND organization_id = $4
       RETURNING id, database_name, description, is_active`,
      [description, isActive, databaseConfigId, organizationId]
    );

    return result.rows[0];
  }

  async deleteDatabase(databaseConfigId, organizationId) {
    const result = await database.query(
      `DELETE FROM database_configurations
       WHERE id = $1 AND organization_id = $2
       RETURNING id, database_name`,
      [databaseConfigId, organizationId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Database configuration not found');
    }

    logger.info(`Database configuration deleted: ${result.rows[0].database_name}`);
    return result.rows[0];
  }
}

export const databaseConfigService = new DatabaseConfigService();
