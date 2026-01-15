import { database } from '../config/database.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { embeddingService } from './embeddingService.js';
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

      // Extract foreign key relationships for all tables
      const fkRelationships = await this.extractForeignKeys(pool);

      // Extract primary keys for all tables
      const primaryKeys = await this.extractPrimaryKeys(pool);

      for (const table of tables) {
        const tableName = table.table_name;

        // Get table schema with enhanced info
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

        let tableSchemaId;

        if (existingSchema.rows.length === 0) {
          // Insert new table schema
          const insertResult = await database.query(
            `INSERT INTO table_schemas (database_config_id, table_name, schema_info)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [databaseConfigId, tableName, JSON.stringify(schemaInfo)]
          );

          tableSchemaId = insertResult.rows[0].id;
          indexedCount++;
        } else {
          tableSchemaId = existingSchema.rows[0].id;
        }

        // Get table's primary key columns
        const tablePKs = primaryKeys[tableName] || [];

        // Get table's foreign key info
        const tableFKs = fkRelationships.filter(fk => fk.from_table === tableName);

        // Insert/update column metadata with enhanced info
        for (const column of schemaInfo) {
          const isPK = tablePKs.includes(column.column_name);
          const fkInfo = tableFKs.find(fk => fk.from_column === column.column_name);
          const fkRef = fkInfo ? `${fkInfo.to_table}.${fkInfo.to_column}` : null;

          // Infer semantic type and aggregation hint
          const semanticType = this.inferSemanticType(column, isPK, !!fkRef);
          const aggregationHint = this.inferAggregationHint(semanticType, column.column_name);

          await database.query(
            `INSERT INTO column_metadata
             (table_schema_id, column_name, data_type, is_nullable, is_primary_key, foreign_key_ref, semantic_type, aggregation_hint)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (table_schema_id, column_name)
             DO UPDATE SET
               data_type = EXCLUDED.data_type,
               is_nullable = EXCLUDED.is_nullable,
               is_primary_key = EXCLUDED.is_primary_key,
               foreign_key_ref = EXCLUDED.foreign_key_ref,
               semantic_type = COALESCE(column_metadata.semantic_type, EXCLUDED.semantic_type),
               aggregation_hint = COALESCE(column_metadata.aggregation_hint, EXCLUDED.aggregation_hint),
               updated_at = CURRENT_TIMESTAMP`,
            [
              tableSchemaId,
              column.column_name,
              column.data_type,
              column.is_nullable === 'YES',
              isPK,
              fkRef,
              semanticType,
              aggregationHint
            ]
          );
        }

        // Generate embedding for the table
        try {
          if (existingSchema.rows.length === 0) {
            await embeddingService.generateAndStoreEmbedding(
              databaseConfigId,
              tableName,
              schemaInfo,
              null
            );
          } else {
            await embeddingService.regenerateTableEmbedding(databaseConfigId, tableName);
          }
        } catch (embeddingError) {
          logger.warn(`Failed to generate embedding for table ${tableName}:`, embeddingError);
        }
      }

      // Store foreign key relationships in table_relationships
      await this.storeForeignKeyRelationships(databaseConfigId, fkRelationships);

      await pool.end();
      logger.info(`Indexed ${indexedCount} tables for database config ${databaseConfigId}`);

      return {
        totalTables: tables.length,
        indexedTables: indexedCount,
        relationshipsFound: fkRelationships.length,
        message: `Successfully indexed ${indexedCount} new tables with ${fkRelationships.length} relationships`
      };
    } catch (error) {
      await pool.end();
      logger.error('Database indexing failed:', error);
      throw error;
    }
  }

  async extractForeignKeys(pool) {
    const result = await pool.query(`
      SELECT
        tc.table_name AS from_table,
        kcu.column_name AS from_column,
        ccu.table_name AS to_table,
        ccu.column_name AS to_column
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
    `);

    return result.rows;
  }

  async extractPrimaryKeys(pool) {
    const result = await pool.query(`
      SELECT
        tc.table_name,
        kcu.column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
    `);

    // Group by table name
    const pkMap = {};
    for (const row of result.rows) {
      if (!pkMap[row.table_name]) {
        pkMap[row.table_name] = [];
      }
      pkMap[row.table_name].push(row.column_name);
    }

    return pkMap;
  }

  async storeForeignKeyRelationships(databaseConfigId, fkRelationships) {
    for (const fk of fkRelationships) {
      await database.query(
        `INSERT INTO table_relationships
         (database_config_id, from_table, from_column, to_table, to_column, relationship_type)
         VALUES ($1, $2, $3, $4, $5, 'foreign_key')
         ON CONFLICT (database_config_id, from_table, from_column, to_table, to_column) DO NOTHING`,
        [databaseConfigId, fk.from_table, fk.from_column, fk.to_table, fk.to_column]
      );
    }
  }

  inferSemanticType(column, isPrimaryKey, isForeignKey) {
    const name = column.column_name.toLowerCase();
    const type = column.data_type.toLowerCase();

    // Primary/Foreign key detection
    if (isPrimaryKey) return 'PK';
    if (isForeignKey) return 'FK';

    // ID detection (non-PK/FK)
    if (name === 'id' || name.endsWith('_id')) return 'ID';

    // Money/Price detection
    if (name.includes('price') || name.includes('amount') || name.includes('cost') ||
        name.includes('revenue') || name.includes('total') || name.includes('fee') ||
        name.includes('salary') || name.includes('payment') || name.includes('balance')) {
      return 'MONEY';
    }

    // Quantity detection
    if (name.includes('quantity') || name.includes('count') || name.includes('qty') ||
        name.includes('num_') || name.includes('number_of') || name.includes('stock')) {
      return 'QUANTITY';
    }

    // Percentage/Rate detection
    if (name.includes('rate') || name.includes('percent') || name.includes('ratio') ||
        name.includes('discount') || name.includes('tax')) {
      return 'PERCENTAGE';
    }

    // Date/Time detection
    if (name.includes('date') || name.includes('_at') || name.includes('time') ||
        name.includes('yymmdd') || type.includes('timestamp') || type.includes('date')) {
      return 'DATE';
    }

    // Status/Category detection
    if (name.includes('status') || name.includes('type') || name.includes('category') ||
        name.includes('state') || name.includes('level') || name.includes('tier')) {
      return 'CATEGORICAL';
    }

    // Name/Text detection
    if (name.includes('name') || name.includes('title') || name.includes('label') ||
        name.includes('description') || name.includes('email') || name.includes('phone')) {
      return 'TEXT';
    }

    // Boolean detection
    if (type === 'boolean' || name.startsWith('is_') || name.startsWith('has_') ||
        name.startsWith('can_') || name.includes('_flag')) {
      return 'BOOLEAN';
    }

    return 'OTHER';
  }

  inferAggregationHint(semanticType, columnName) {
    switch (semanticType) {
      case 'MONEY':
      case 'QUANTITY':
        return 'SUM';
      case 'PERCENTAGE':
        return 'AVG';
      case 'DATE':
      case 'CATEGORICAL':
        return 'GROUP_BY';
      case 'PK':
      case 'FK':
      case 'ID':
        return 'COUNT';
      case 'BOOLEAN':
        return 'COUNT';
      default:
        return 'NONE';
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
    // Verify table belongs to organization and get table info
    const verifyResult = await database.query(
      `SELECT ts.id, ts.database_config_id, ts.table_name
       FROM table_schemas ts
       JOIN database_configurations dc ON ts.database_config_id = dc.id
       WHERE ts.id = $1 AND dc.organization_id = $2`,
      [tableSchemaId, organizationId]
    );

    if (verifyResult.rows.length === 0) {
      throw new NotFoundError('Table not found or access denied');
    }

    const tableInfo = verifyResult.rows[0];

    const result = await database.query(
      `UPDATE table_schemas
       SET table_description = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, table_name, table_description`,
      [tableDescription, tableSchemaId]
    );

    // Regenerate embedding with updated description
    try {
      await embeddingService.regenerateTableEmbedding(
        tableInfo.database_config_id,
        tableInfo.table_name
      );
    } catch (embeddingError) {
      logger.warn(`Failed to regenerate embedding after table description update:`, embeddingError);
      // Continue even if embedding fails
    }

    return result.rows[0];
  }

  async updateColumnDescription(tableSchemaId, columnName, columnDescription, organizationId) {
    // Verify table belongs to organization and get table info
    const verifyResult = await database.query(
      `SELECT ts.id, ts.database_config_id, ts.table_name
       FROM table_schemas ts
       JOIN database_configurations dc ON ts.database_config_id = dc.id
       WHERE ts.id = $1 AND dc.organization_id = $2`,
      [tableSchemaId, organizationId]
    );

    if (verifyResult.rows.length === 0) {
      throw new NotFoundError('Table not found or access denied');
    }

    const tableInfo = verifyResult.rows[0];

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

    // Regenerate embedding with updated column description
    try {
      await embeddingService.regenerateTableEmbedding(
        tableInfo.database_config_id,
        tableInfo.table_name
      );
    } catch (embeddingError) {
      logger.warn(`Failed to regenerate embedding after column description update:`, embeddingError);
      // Continue even if embedding fails
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
