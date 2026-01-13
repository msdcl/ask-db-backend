import { database } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { ExternalServiceError } from '../utils/errors.js';
import { llmClient } from './llmClient.js';

class EmbeddingService {
  async generateEmbedding(text) {
    try {
      return await llmClient.generateEmbedding(text);
    } catch (error) {
      logger.error('Embedding generation failed:', error);
      throw new ExternalServiceError('Failed to generate embedding');
    }
  }

  async storeTableSchema(databaseName, tableName, schemaInfo) {
    try {
      const schemaText = this.formatSchemaForEmbedding(tableName, schemaInfo);
      const embedding = await this.generateEmbedding(schemaText);

      await database.query(
        `INSERT INTO table_schemas (database_name, table_name, schema_info, embedding)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (database_name, table_name)
         DO UPDATE SET
           schema_info = EXCLUDED.schema_info,
           embedding = EXCLUDED.embedding,
           updated_at = CURRENT_TIMESTAMP`,
        [databaseName, tableName, JSON.stringify(schemaInfo), JSON.stringify(embedding)]
      );

      logger.info(`Schema stored for ${databaseName}.${tableName}`);
    } catch (error) {
      logger.error('Failed to store table schema:', error);
      throw error;
    }
  }

  async generateAndStoreEmbedding(databaseConfigId, tableName, schemaInfo, tableDescription = null) {
    try {
      // Get column descriptions if they exist
      const columnDescResult = await database.query(
        `SELECT cm.column_name, cm.column_description
         FROM table_schemas ts
         JOIN column_metadata cm ON ts.id = cm.table_schema_id
         WHERE ts.database_config_id = $1 AND ts.table_name = $2 AND cm.column_description IS NOT NULL`,
        [databaseConfigId, tableName]
      );

      const columnDescriptions = {};
      columnDescResult.rows.forEach(row => {
        columnDescriptions[row.column_name] = row.column_description;
      });

      const schemaText = this.formatSchemaForEmbedding(
        tableName,
        schemaInfo,
        tableDescription,
        columnDescriptions
      );

      const embedding = await this.generateEmbedding(schemaText);

      await database.query(
        `UPDATE table_schemas
         SET embedding = $1, updated_at = CURRENT_TIMESTAMP
         WHERE database_config_id = $2 AND table_name = $3`,
        [JSON.stringify(embedding), databaseConfigId, tableName]
      );

      logger.info(`Embedding generated for table ${tableName} in database config ${databaseConfigId}`);
    } catch (error) {
      logger.error('Failed to generate and store embedding:', error);
      throw error;
    }
  }

  async findRelevantTablesByEmbedding(queryEmbedding, databaseConfigId, limit = 5) {
    try {
      // First, get relevant tables with their embeddings using cosine similarity
      const tablesResult = await database.query(
        `SELECT
           ts.id,
           ts.table_name,
           ts.schema_info,
           ts.table_description,
           1 - (ts.embedding <=> $1::vector) AS similarity
         FROM table_schemas ts
         WHERE ts.database_config_id = $2 AND ts.embedding IS NOT NULL
         ORDER BY ts.embedding <=> $1::vector
         LIMIT $3`,
        [JSON.stringify(queryEmbedding), databaseConfigId, limit]
      );

      if (tablesResult.rows.length === 0) {
        return [];
      }

      // Get column descriptions for all relevant tables
      const tableIds = tablesResult.rows.map(row => row.id);
      const columnDescResult = await database.query(
        `SELECT 
           cm.table_schema_id,
           cm.column_name,
           cm.column_description
         FROM column_metadata cm
         WHERE cm.table_schema_id = ANY($1::int[]) AND cm.column_description IS NOT NULL`,
        [tableIds]
      );

      // Build a map of table_id -> { column_name -> column_description }
      const columnDescriptionsMap = {};
      columnDescResult.rows.forEach(row => {
        if (!columnDescriptionsMap[row.table_schema_id]) {
          columnDescriptionsMap[row.table_schema_id] = {};
        }
        columnDescriptionsMap[row.table_schema_id][row.column_name] = row.column_description;
      });

      // Combine table info with column descriptions and filter by similarity > 0
      return tablesResult.rows
        .filter((row) => row.similarity > 0)
        .map((row) => {
          const schemaInfo = Array.isArray(row.schema_info) 
            ? row.schema_info 
            : typeof row.schema_info === 'string' 
              ? JSON.parse(row.schema_info) 
              : row.schema_info;

          // Enrich schema info with column descriptions
          const enrichedSchemaInfo = schemaInfo.map(col => ({
            ...col,
            column_description: columnDescriptionsMap[row.id]?.[col.column_name] || null
          }));

          return {
            tableName: row.table_name,
            schemaInfo: enrichedSchemaInfo,
            tableDescription: row.table_description,
            similarity: row.similarity,
          };
        });
    } catch (error) {
      // Check if it's a dimension mismatch error
      if (error.message && (
        error.message.includes('different vector dimensions') ||
        error.message.includes('cannot cast type vector') ||
        error.message.includes('dimension')
      )) {
        const helpfulError = new Error(
          'Embedding dimension mismatch detected. The database has embeddings with a different dimension ' +
          'than the current embedding model. Please run the migration script to fix this:\n' +
          '  node scripts/migrate_embedding_dimension.js\n' +
          'Then regenerate embeddings:\n' +
          '  node scripts/regenerate_embeddings.js'
        );
        helpfulError.cause = error;
        logger.error('Dimension mismatch error:', error);
        throw helpfulError;
      }
      logger.error('Failed to find relevant tables:', error);
      throw error;
    }
  }

  async findRelevantTables(query, databaseConfigId, limit = 5) {
    const queryEmbedding = await this.generateEmbedding(query);
    return this.findRelevantTablesByEmbedding(queryEmbedding, databaseConfigId, limit);
  }

  formatSchemaForEmbedding(tableName, schemaInfo, tableDescription = null, columnDescriptions = {}) {
    const columns = schemaInfo
      .map((col) => {
        const columnDesc = columnDescriptions[col.column_name];
        const columnInfo = `${col.column_name} (${col.data_type})${col.is_nullable === 'NO' ? ' NOT NULL' : ''}`;
        return columnDesc ? `${columnInfo} - ${columnDesc}` : columnInfo;
      })
      .join(', ');

    let result = `Table: ${tableName}`;
    if (tableDescription) {
      result += ` - ${tableDescription}`;
    }
    result += `. Columns: ${columns}`;

    return result;
  }

  async regenerateTableEmbedding(databaseConfigId, tableName) {
    try {
      // Get table schema with descriptions
      const result = await database.query(
        `SELECT 
           ts.table_name,
           ts.table_description,
           ts.schema_info,
           json_object_agg(cm.column_name, cm.column_description) FILTER (WHERE cm.column_description IS NOT NULL) as column_descriptions
         FROM table_schemas ts
         LEFT JOIN column_metadata cm ON ts.id = cm.table_schema_id
         WHERE ts.database_config_id = $1 AND ts.table_name = $2
         GROUP BY ts.id, ts.table_name, ts.table_description, ts.schema_info`,
        [databaseConfigId, tableName]
      );

      if (result.rows.length === 0) {
        throw new Error(`Table ${tableName} not found for database config ${databaseConfigId}`);
      }

      const row = result.rows[0];
      const schemaInfo = Array.isArray(row.schema_info) 
        ? row.schema_info 
        : typeof row.schema_info === 'string' 
          ? JSON.parse(row.schema_info) 
          : row.schema_info;
      const columnDescriptions = (row.column_descriptions && typeof row.column_descriptions === 'object') 
        ? row.column_descriptions 
        : {};

      const schemaText = this.formatSchemaForEmbedding(
        row.table_name,
        schemaInfo,
        row.table_description,
        columnDescriptions
      );

      const embedding = await this.generateEmbedding(schemaText);

      await database.query(
        `UPDATE table_schemas
         SET embedding = $1, updated_at = CURRENT_TIMESTAMP
         WHERE database_config_id = $2 AND table_name = $3`,
        [JSON.stringify(embedding), databaseConfigId, tableName]
      );

      logger.info(`Embedding regenerated for table ${tableName} in database config ${databaseConfigId}`);
    } catch (error) {
      logger.error('Failed to regenerate table embedding:', error);
      throw error;
    }
  }
}

export const embeddingService = new EmbeddingService();
