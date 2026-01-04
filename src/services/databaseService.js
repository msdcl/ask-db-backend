import pg from 'pg';
import { config } from '../config/env.js';
import { database } from '../config/database.js';
import { embeddingService } from './embeddingService.js';
import { logger } from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

const { Pool } = pg;

class DatabaseService {
  constructor() {
    this.connectionPools = new Map();
  }

  async getAvailableDatabases() {
    try {
      const pool = new Pool({
        host: config.database.host,
        port: config.database.port,
        user: config.database.user,
        password: config.database.password,
        database: 'postgres',
      });

      const result = await pool.query(
        `SELECT datname FROM pg_database
         WHERE datistemplate = false
         AND datname NOT IN ('postgres', 'template0', 'template1')
         ORDER BY datname`
      );

      await pool.end();

      return result.rows.map((row) => row.datname);
    } catch (error) {
      logger.error('Failed to fetch databases:', error);
      throw new DatabaseError('Failed to retrieve available databases');
    }
  }

  async getTablesInDatabase(databaseName) {
    try {
      const pool = await this.getConnectionPool(databaseName);

      const result = await pool.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
         ORDER BY table_name`
      );

      return result.rows.map((row) => row.table_name);
    } catch (error) {
      logger.error('Failed to fetch tables:', error);
      throw new DatabaseError('Failed to retrieve tables');
    }
  }

  async getTableSchema(databaseName, tableName) {
    try {
      const pool = await this.getConnectionPool(databaseName);

      const result = await pool.query(
        `SELECT
           column_name,
           data_type,
           is_nullable,
           column_default
         FROM information_schema.columns
         WHERE table_schema = 'public'
         AND table_name = $1
         ORDER BY ordinal_position`,
        [tableName]
      );

      if (result.rows.length === 0) {
        throw new NotFoundError(`Table ${tableName} not found`);
      }

      return result.rows;
    } catch (error) {
      logger.error('Failed to fetch table schema:', error);
      throw error;
    }
  }

  async getTableData(databaseName, tableName, limit = 100, offset = 0) {
    try {
      const pool = await this.getConnectionPool(databaseName);

      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM ${tableName}`
      );
      const total = parseInt(countResult.rows[0].total);

      const dataResult = await pool.query(
        `SELECT * FROM ${tableName} LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      return {
        data: dataResult.rows,
        total,
        limit,
        offset,
      };
    } catch (error) {
      logger.error('Failed to fetch table data:', error);
      throw new DatabaseError('Failed to retrieve table data');
    }
  }

  async executeQuery(databaseConfigId, organizationId, sqlQuery) {
    const startTime = Date.now();
    let status = 'success';
    let errorMessage = null;

    try {
      const configResult = await database.query(
        `SELECT database_name, host, port, username, password
         FROM database_configurations
         WHERE id = $1 AND organization_id = $2 AND is_active = true`,
        [databaseConfigId, organizationId]
      );

      if (configResult.rows.length === 0) {
        throw new NotFoundError('Database configuration not found or inactive');
      }

      const dbConfig = configResult.rows[0];
      const poolKey = `${dbConfig.host}:${dbConfig.port}:${dbConfig.database_name}`;

      if (!this.connectionPools.has(poolKey)) {
        const pool = new Pool({
          host: dbConfig.host,
          port: dbConfig.port,
          user: dbConfig.username,
          password: dbConfig.password,
          database: dbConfig.database_name,
          max: 10,
          idleTimeoutMillis: 30000,
        });

        pool.on('error', (err) => {
          logger.error(`Pool error for ${poolKey}:`, err);
          this.connectionPools.delete(poolKey);
        });

        this.connectionPools.set(poolKey, pool);
      }

      const pool = this.connectionPools.get(poolKey);
      const result = await pool.query(sqlQuery);

      const executionTime = Date.now() - startTime;

      logger.info('Query executed successfully', {
        databaseConfigId,
        databaseName: dbConfig.database_name,
        executionTime,
        rowCount: result.rowCount,
      });

      return {
        success: true,
        data: result.rows,
        rowCount: result.rowCount,
        executionTime,
      };
    } catch (error) {
      status = 'error';
      errorMessage = error.message;
      logger.error('Query execution failed:', error);
      throw new DatabaseError(`Query execution failed: ${error.message}`);
    } finally {
      const executionTime = Date.now() - startTime;
    }
  }

  async indexDatabase(databaseName) {
    try {
      const tables = await this.getTablesInDatabase(databaseName);

      for (const tableName of tables) {
        const schema = await this.getTableSchema(databaseName, tableName);
        await embeddingService.storeTableSchema(databaseName, tableName, schema);
      }

      logger.info(`Database ${databaseName} indexed successfully`);

      return {
        success: true,
        tablesIndexed: tables.length,
        tables,
      };
    } catch (error) {
      logger.error('Database indexing failed:', error);
      throw new DatabaseError('Failed to index database');
    }
  }

  async getConnectionPool(databaseName) {
    if (!this.connectionPools.has(databaseName)) {
      const pool = new Pool({
        host: config.database.host,
        port: config.database.port,
        user: config.database.user,
        password: config.database.password,
        database: databaseName,
        max: 10,
        idleTimeoutMillis: 30000,
      });

      pool.on('error', (err) => {
        logger.error(`Pool error for database ${databaseName}:`, err);
        this.connectionPools.delete(databaseName);
      });

      this.connectionPools.set(databaseName, pool);
    }

    return this.connectionPools.get(databaseName);
  }

  async closeAllPools() {
    for (const [dbName, pool] of this.connectionPools.entries()) {
      await pool.end();
      logger.info(`Connection pool closed for ${dbName}`);
    }
    this.connectionPools.clear();
  }
}

export const databaseService = new DatabaseService();
