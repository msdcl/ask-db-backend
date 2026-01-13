/**
 * Regenerate embeddings for all indexed tables.
 *
 * Usage: node scripts/regenerate_embeddings.js
 *
 * If you changed the embedding model or dimension, run:
 *   node scripts/migrate_embedding_dimension.js
 * before running this script.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dotenv = require('dotenv');
const envPath = join(__dirname, '..', '.env');
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error('Error loading .env file:', result.error);
  console.error('Looking for .env at:', envPath);
  process.exit(1);
}

async function regenerateEmbeddings() {
  const { database } = await import('../src/config/database.js');
  const { logger } = await import('../src/utils/logger.js');
  const { embeddingService } = await import('../src/services/embeddingService.js');

  try {
    logger.info('Starting embedding regeneration...');
    await database.connect();

    const { rows } = await database.query(
      `SELECT
         ts.id,
         ts.table_name,
         ts.table_description,
         ts.schema_info,
         json_object_agg(cm.column_name, cm.column_description)
           FILTER (WHERE cm.column_description IS NOT NULL) AS column_descriptions
       FROM table_schemas ts
       LEFT JOIN column_metadata cm ON ts.id = cm.table_schema_id
       GROUP BY ts.id, ts.table_name, ts.table_description, ts.schema_info
       ORDER BY ts.id`
    );

    let regeneratedCount = 0;
    for (const row of rows) {
      const schemaInfo = Array.isArray(row.schema_info)
        ? row.schema_info
        : typeof row.schema_info === 'string'
          ? JSON.parse(row.schema_info)
          : row.schema_info;
      const columnDescriptions = row.column_descriptions || {};

      const schemaText = embeddingService.formatSchemaForEmbedding(
        row.table_name,
        schemaInfo,
        row.table_description,
        columnDescriptions
      );

      const embedding = await embeddingService.generateEmbedding(schemaText);

      await database.query(
        `UPDATE table_schemas
         SET embedding = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [JSON.stringify(embedding), row.id]
      );

      regeneratedCount += 1;
    }

    logger.info(`✅ Regenerated embeddings for ${regeneratedCount} tables.`);
    process.exit(0);
  } catch (error) {
    logger.error('Embedding regeneration failed:', error);
    process.exit(1);
  }
}

regenerateEmbeddings();
