import pg from 'pg';
import { config } from './env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

class Database {
  constructor() {
    this.pool = null;
  }

  async connect() {
    try {
      this.pool = new Pool({
        host: config.database.host,
        port: config.database.port,
        user: config.database.user,
        password: config.database.password,
        database: config.database.database,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      });

      this.pool.on('error', (err) => {
        logger.error('Unexpected database error:', err);
      });

      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();

      logger.info('Database connected successfully');
      await this.initializePgVector();
    } catch (error) {
      logger.error('Database connection failed:', error);
      throw error;
    }
  }

  async initializePgVector() {
    try {
      const client = await this.pool.connect();

      await client.query('CREATE EXTENSION IF NOT EXISTS vector');

      logger.info('PGVector extension initialized');
      client.release();
    } catch (error) {
      logger.error('PGVector initialization failed:', error);
      throw error;
    }
  }

  async initializeSchema() {
    try {
      const client = await this.pool.connect();

      // Organizations table
      await client.query(`
        CREATE TABLE IF NOT EXISTS organizations (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Users table with organization reference
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          user_type VARCHAR(20) NOT NULL CHECK (user_type IN ('admin', 'user')),
          organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Database configurations table
      await client.query(`
        CREATE TABLE IF NOT EXISTS database_configurations (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          database_name VARCHAR(255) NOT NULL,
          host VARCHAR(255) NOT NULL,
          port INTEGER NOT NULL,
          username VARCHAR(255) NOT NULL,
          password VARCHAR(255) NOT NULL,
          database_type VARCHAR(50) DEFAULT 'postgresql',
          description TEXT,
          is_active BOOLEAN DEFAULT true,
          created_by INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(organization_id, database_name)
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS refresh_tokens (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token VARCHAR(500) NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Table schemas with metadata
      await client.query(`
        CREATE TABLE IF NOT EXISTS table_schemas (
          id SERIAL PRIMARY KEY,
          database_config_id INTEGER NOT NULL REFERENCES database_configurations(id) ON DELETE CASCADE,
          table_name VARCHAR(255) NOT NULL,
          table_description TEXT,
          schema_info JSONB NOT NULL,
          embedding vector(${config.embedding.dimension}),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(database_config_id, table_name)
        );
      `);

      // Column metadata table with enhanced fields
      await client.query(`
        CREATE TABLE IF NOT EXISTS column_metadata (
          id SERIAL PRIMARY KEY,
          table_schema_id INTEGER NOT NULL REFERENCES table_schemas(id) ON DELETE CASCADE,
          column_name VARCHAR(255) NOT NULL,
          column_description TEXT,
          data_type VARCHAR(100),
          is_nullable BOOLEAN,
          is_primary_key BOOLEAN DEFAULT FALSE,
          foreign_key_ref VARCHAR(255),
          semantic_type VARCHAR(50),
          aggregation_hint VARCHAR(50),
          sample_values JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(table_schema_id, column_name)
        );
      `);
      await client.query(
        `ALTER TABLE column_metadata
         ADD COLUMN IF NOT EXISTS column_description TEXT`
      );
      await client.query(
        `ALTER TABLE column_metadata
         ADD COLUMN IF NOT EXISTS data_type VARCHAR(100)`
      );
      await client.query(
        `ALTER TABLE column_metadata
         ADD COLUMN IF NOT EXISTS is_nullable BOOLEAN`
      );
      await client.query(
        `ALTER TABLE column_metadata
         ADD COLUMN IF NOT EXISTS is_primary_key BOOLEAN DEFAULT FALSE`
      );
      await client.query(
        `ALTER TABLE column_metadata
         ADD COLUMN IF NOT EXISTS foreign_key_ref VARCHAR(255)`
      );
      await client.query(
        `ALTER TABLE column_metadata
         ADD COLUMN IF NOT EXISTS semantic_type VARCHAR(50)`
      );
      await client.query(
        `ALTER TABLE column_metadata
         ADD COLUMN IF NOT EXISTS aggregation_hint VARCHAR(50)`
      );
      await client.query(
        `ALTER TABLE column_metadata
         ADD COLUMN IF NOT EXISTS sample_values JSONB`
      );

      // Table relationships for FK tracking
      await client.query(`
        CREATE TABLE IF NOT EXISTS table_relationships (
          id SERIAL PRIMARY KEY,
          database_config_id INTEGER NOT NULL REFERENCES database_configurations(id) ON DELETE CASCADE,
          from_table VARCHAR(255) NOT NULL,
          from_column VARCHAR(255) NOT NULL,
          to_table VARCHAR(255) NOT NULL,
          to_column VARCHAR(255) NOT NULL,
          relationship_type VARCHAR(50) DEFAULT 'foreign_key',
          cardinality VARCHAR(20),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(database_config_id, from_table, from_column, to_table, to_column)
        );
      `);

      // Query examples for few-shot learning
      await client.query(`
        CREATE TABLE IF NOT EXISTS query_examples (
          id SERIAL PRIMARY KEY,
          database_config_id INTEGER REFERENCES database_configurations(id) ON DELETE CASCADE,
          natural_query TEXT NOT NULL,
          intent_type VARCHAR(50),
          generated_sql TEXT NOT NULL,
          tables_used JSONB,
          was_successful BOOLEAN DEFAULT TRUE,
          feedback_score INTEGER,
          embedding vector(${config.embedding.dimension}),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_table_schemas_embedding
        ON table_schemas USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS query_history (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          database_config_id INTEGER NOT NULL REFERENCES database_configurations(id) ON DELETE CASCADE,
          natural_query TEXT NOT NULL,
          generated_sql TEXT NOT NULL,
          execution_status VARCHAR(20) NOT NULL,
          error_message TEXT,
          execution_time_ms INTEGER,
          result_count INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_query_history_user_id ON query_history(user_id);
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_query_history_created_at ON query_history(created_at DESC);
      `);

      // Indexes for table_relationships
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_table_relationships_from
        ON table_relationships(database_config_id, from_table);
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_table_relationships_to
        ON table_relationships(database_config_id, to_table);
      `);

      // Index for query_examples embedding search
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_query_examples_embedding
        ON query_examples USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);
      `);

      logger.info('Database schema initialized successfully');
      client.release();
    } catch (error) {
      logger.error('Schema initialization failed:', error);
      throw error;
    }
  }

  getPool() {
    if (!this.pool) {
      throw new Error('Database not connected. Call connect() first.');
    }
    return this.pool;
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      logger.info('Database connection closed');
    }
  }
}

export const database = new Database();
