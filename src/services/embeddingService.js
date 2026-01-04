import { OpenAIEmbeddings } from '@langchain/openai';
import { config } from '../config/env.js';
import { database } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { ExternalServiceError } from '../utils/errors.js';

class EmbeddingService {
  constructor() {
    this.embeddings = new OpenAIEmbeddings({
      openAIApiKey: config.openai.apiKey,
      modelName: config.embedding.model,
    });
  }

  async generateEmbedding(text) {
    try {
      const embedding = await this.embeddings.embedQuery(text);
      return embedding;
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

  async findRelevantTables(query, databaseConfigId, limit = 5) {
    try {
      const queryEmbedding = await this.generateEmbedding(query);

      const result = await database.query(
        `SELECT
           table_name,
           schema_info,
           table_description,
           1 - (embedding <=> $1::vector) AS similarity
         FROM table_schemas
         WHERE database_config_id = $2
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [JSON.stringify(queryEmbedding), databaseConfigId, limit]
      );

      return result.rows.map((row) => ({
        tableName: row.table_name,
        schemaInfo: row.schema_info,
        tableDescription: row.table_description,
        similarity: row.similarity,
      }));
    } catch (error) {
      logger.error('Failed to find relevant tables:', error);
      throw error;
    }
  }

  formatSchemaForEmbedding(tableName, schemaInfo) {
    const columns = schemaInfo
      .map(
        (col) =>
          `${col.column_name} (${col.data_type})${col.is_nullable === 'NO' ? ' NOT NULL' : ''}`
      )
      .join(', ');

    return `Table: ${tableName}. Columns: ${columns}`;
  }
}

export const embeddingService = new EmbeddingService();
