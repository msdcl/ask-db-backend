import { database } from '../../config/database.js';
import { embeddingService } from '../embeddingService.js';
import { schemaEnricher } from './schemaEnricher.js';
import { logger } from '../../utils/logger.js';

export class TableRetriever {
  constructor(options = {}) {
    this.minSimilarity = options.minSimilarity || 0.25;
    this.maxTables = options.maxTables || 15;
    this.maxFKHops = options.maxFKHops || 2;
  }

  /**
   * Multi-strategy table retrieval
   * 1. Embedding similarity
   * 2. Entity/keyword matching
   * 3. FK relationship expansion
   * 4. Glossary-required tables
   */
  async retrieveTables(queryAnalysis, databaseConfigId, options = {}) {
    const limit = options.limit || this.maxTables;

    // Strategy 1: Embedding similarity (with stricter threshold)
    const embeddingResults = await this.embeddingSimilarity(
      queryAnalysis.enrichedQuery || queryAnalysis.originalQuery,
      databaseConfigId,
      { minSimilarity: this.minSimilarity, limit: 10 }
    );

    // Strategy 2: Entity-based matching
    const entityResults = await this.entityMatching(
      queryAnalysis.entities || [],
      databaseConfigId
    );

    // Strategy 3: Keyword matching in column names
    const keywordResults = await this.keywordMatching(
      queryAnalysis.originalQuery,
      databaseConfigId
    );

    // Merge initial results
    const initialTables = this.mergeTables([
      ...embeddingResults,
      ...entityResults,
      ...keywordResults,
    ]);

    // Strategy 4: FK relationship expansion (find bridge tables)
    const expandedTables = await this.expandViaRelationships(
      initialTables,
      databaseConfigId
    );

    // Strategy 5: Add tables required by glossary terms
    const glossaryTables = this.getGlossaryRequiredTables(
      queryAnalysis.resolvedTerms || []
    );

    // Final merge and rank
    const allTables = this.mergeTables([
      ...initialTables,
      ...expandedTables,
      ...glossaryTables,
    ]);

    // Enrich with column metadata and relationships
    const enrichedTables = await this.enrichTables(allTables, databaseConfigId);

    // Get relationships between selected tables
    const tableNames = enrichedTables.map((t) => t.tableName);
    const relationships = await schemaEnricher.getRelationships(
      databaseConfigId,
      tableNames
    );

    return {
      tables: enrichedTables.slice(0, limit),
      relationships,
      retrievalStats: {
        embedding: embeddingResults.length,
        entity: entityResults.length,
        keyword: keywordResults.length,
        expanded: expandedTables.length,
        total: enrichedTables.length,
      },
    };
  }

  /**
   * Strategy 1: Embedding-based similarity search
   */
  async embeddingSimilarity(query, databaseConfigId, options = {}) {
    const minSimilarity = options.minSimilarity || this.minSimilarity;
    const limit = options.limit || 10;

    try {
      const queryEmbedding = await embeddingService.generateEmbedding(query);

      const result = await database.query(
        `SELECT
           ts.id,
           ts.table_name,
           ts.schema_info,
           ts.table_description,
           1 - (ts.embedding <=> $1::vector) AS similarity
         FROM table_schemas ts
         WHERE ts.database_config_id = $2
           AND ts.embedding IS NOT NULL
           AND 1 - (ts.embedding <=> $1::vector) >= $3
         ORDER BY ts.embedding <=> $1::vector
         LIMIT $4`,
        [JSON.stringify(queryEmbedding), databaseConfigId, minSimilarity, limit]
      );

      return result.rows.map((row) => ({
        id: row.id,
        tableName: row.table_name,
        schemaInfo: this.parseSchemaInfo(row.schema_info),
        tableDescription: row.table_description,
        similarity: row.similarity,
        source: 'embedding',
      }));
    } catch (error) {
      logger.error('Embedding similarity search failed:', error);
      return [];
    }
  }

  /**
   * Strategy 2: Entity-based table matching
   */
  async entityMatching(entities, databaseConfigId) {
    if (!entities || entities.length === 0) {
      return [];
    }

    // Normalize entities to potential table names
    const normalizedEntities = entities
      .map((entity) => {
        if (typeof entity === 'string') {
          return entity;
        }
        if (entity && typeof entity.type === 'string') {
          return entity.type;
        }
        if (entity && typeof entity.name === 'string') {
          return entity.name;
        }
        return null;
      })
      .filter(Boolean);
    if (normalizedEntities.length === 0) {
      return [];
    }

    const potentialTableNames = normalizedEntities.flatMap((entity) => [
      entity.toLowerCase(),
      entity.toLowerCase() + 's', // plural
      entity.toLowerCase().replace(/s$/, ''), // singular
      entity.toLowerCase().replace(/_/g, ''), // no underscore
    ]);

    const result = await database.query(
      `SELECT
         ts.id,
         ts.table_name,
         ts.schema_info,
         ts.table_description
       FROM table_schemas ts
       WHERE ts.database_config_id = $1
         AND (
           ts.table_name = ANY($2)
           OR ts.table_name ILIKE ANY($3)
         )`,
      [
        databaseConfigId,
        potentialTableNames,
        potentialTableNames.map((n) => `%${n}%`),
      ]
    );

    return result.rows.map((row) => ({
      id: row.id,
      tableName: row.table_name,
      schemaInfo: this.parseSchemaInfo(row.schema_info),
      tableDescription: row.table_description,
      similarity: 0.8, // High confidence for direct match
      source: 'entity',
    }));
  }

  /**
   * Strategy 3: Keyword matching in column names
   */
  async keywordMatching(query, databaseConfigId) {
    // Extract potential keywords from query
    const keywords = this.extractKeywords(query);
    if (keywords.length === 0) {
      return [];
    }

    // Search for tables with matching column names
    const result = await database.query(
      `SELECT DISTINCT
         ts.id,
         ts.table_name,
         ts.schema_info,
         ts.table_description
       FROM table_schemas ts
       JOIN column_metadata cm ON ts.id = cm.table_schema_id
       WHERE ts.database_config_id = $1
         AND (
           cm.column_name ILIKE ANY($2)
           OR cm.column_description ILIKE ANY($2)
         )`,
      [databaseConfigId, keywords.map((k) => `%${k}%`)]
    );

    return result.rows.map((row) => ({
      id: row.id,
      tableName: row.table_name,
      schemaInfo: this.parseSchemaInfo(row.schema_info),
      tableDescription: row.table_description,
      similarity: 0.6, // Medium confidence
      source: 'keyword',
    }));
  }

  /**
   * Strategy 4: Expand via FK relationships
   * Find bridge tables needed for JOINs
   */
  async expandViaRelationships(tables, databaseConfigId) {
    if (tables.length < 2) {
      return [];
    }

    const tableNames = tables.map((t) => t.tableName);
    const expanded = new Set();

    // Get all relationships involving our tables
    const relationships = await database.query(
      `SELECT from_table, from_column, to_table, to_column
       FROM table_relationships
       WHERE database_config_id = $1
         AND (from_table = ANY($2) OR to_table = ANY($2))`,
      [databaseConfigId, tableNames]
    );

    // Find tables that connect our selected tables
    for (const rel of relationships.rows) {
      // If one end is in our tables but the other isn't
      if (tableNames.includes(rel.from_table) && !tableNames.includes(rel.to_table)) {
        expanded.add(rel.to_table);
      }
      if (tableNames.includes(rel.to_table) && !tableNames.includes(rel.from_table)) {
        expanded.add(rel.from_table);
      }
    }

    // Also find tables that bridge two of our selected tables
    const bridgeTables = await this.findBridgeTables(tableNames, databaseConfigId);
    bridgeTables.forEach((t) => expanded.add(t));

    // Fetch full info for expanded tables
    if (expanded.size === 0) {
      return [];
    }

    const expandedNames = Array.from(expanded);
    const result = await database.query(
      `SELECT
         ts.id,
         ts.table_name,
         ts.schema_info,
         ts.table_description
       FROM table_schemas ts
       WHERE ts.database_config_id = $1
         AND ts.table_name = ANY($2)`,
      [databaseConfigId, expandedNames]
    );

    return result.rows.map((row) => ({
      id: row.id,
      tableName: row.table_name,
      schemaInfo: this.parseSchemaInfo(row.schema_info),
      tableDescription: row.table_description,
      similarity: 0.5, // Lower confidence for FK-expanded
      source: 'fk_expansion',
    }));
  }

  /**
   * Find tables that bridge two other tables
   */
  async findBridgeTables(tableNames, databaseConfigId) {
    const result = await database.query(
      `SELECT DISTINCT r1.from_table AS bridge
       FROM table_relationships r1
       JOIN table_relationships r2 ON r1.from_table = r2.from_table
       WHERE r1.database_config_id = $1
         AND r2.database_config_id = $1
         AND r1.to_table = ANY($2)
         AND r2.to_table = ANY($2)
         AND r1.to_table != r2.to_table
         AND r1.from_table != ALL($2)`,
      [databaseConfigId, tableNames]
    );

    return result.rows.map((r) => r.bridge);
  }

  /**
   * Get tables required by glossary terms
   */
  getGlossaryRequiredTables(resolvedTerms) {
    const tables = [];

    for (const term of resolvedTerms) {
      if (term.tables) {
        for (const tableName of term.tables) {
          if (!tables.find((t) => t.tableName === tableName)) {
            tables.push({
              tableName,
              similarity: 0.7,
              source: 'glossary',
            });
          }
        }
      }
    }

    return tables;
  }

  /**
   * Enrich tables with full column metadata
   */
  async enrichTables(tables, databaseConfigId) {
    const tableIds = tables.filter((t) => t.id).map((t) => t.id);

    // For tables without IDs (from glossary), fetch them
    const tablesWithoutIds = tables.filter((t) => !t.id);
    if (tablesWithoutIds.length > 0) {
      const names = tablesWithoutIds.map((t) => t.tableName);
      const result = await database.query(
        `SELECT id, table_name, schema_info, table_description
         FROM table_schemas
         WHERE database_config_id = $1 AND table_name = ANY($2)`,
        [databaseConfigId, names]
      );

      for (const row of result.rows) {
        const idx = tables.findIndex((t) => t.tableName === row.table_name);
        if (idx >= 0) {
          tables[idx].id = row.id;
          tables[idx].schemaInfo = this.parseSchemaInfo(row.schema_info);
          tables[idx].tableDescription = row.table_description;
        }
        tableIds.push(row.id);
      }
    }

    // Get enhanced column metadata
    if (tableIds.length > 0) {
      const columnMetadata = await schemaEnricher.getEnhancedColumnMetadata(tableIds);

      return tables
        .filter((t) => t.id)
        .map((t) => schemaEnricher.enrichTableSchema(t, columnMetadata));
    }

    return tables;
  }

  /**
   * Merge tables from multiple sources, keeping highest similarity
   */
  mergeTables(tables) {
    const tableMap = new Map();

    for (const table of tables) {
      const existing = tableMap.get(table.tableName);
      if (!existing || table.similarity > existing.similarity) {
        tableMap.set(table.tableName, table);
      }
    }

    // Sort by similarity descending
    return Array.from(tableMap.values()).sort(
      (a, b) => (b.similarity || 0) - (a.similarity || 0)
    );
  }

  /**
   * Extract meaningful keywords from query
   */
  extractKeywords(query) {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
      'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
      'am', 'it', 'its', 'my', 'your', 'his', 'her', 'our', 'their',
      'show', 'get', 'find', 'list', 'display', 'give', 'tell', 'me',
      'all', 'each', 'every', 'most', 'top', 'best', 'last', 'first',
    ]);

    const words = query
      .toLowerCase()
      .replace(/[^a-z0-9\s_]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    return [...new Set(words)];
  }

  parseSchemaInfo(schemaInfo) {
    if (!schemaInfo) return [];
    if (Array.isArray(schemaInfo)) return schemaInfo;
    try {
      return JSON.parse(schemaInfo);
    } catch {
      return [];
    }
  }
}

export const tableRetriever = new TableRetriever();
