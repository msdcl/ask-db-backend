import { database } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

export class SchemaEnricher {
  /**
   * Build rich schema context for LLM consumption
   * Includes: columns with semantic types, FK relationships, aggregation hints
   */
  buildSchemaContext(relevantTables, relationships = []) {
    return relevantTables
      .map((table) => {
        let output = `Table: ${table.tableName}`;
        if (table.tableDescription) {
          output += ` - ${table.tableDescription}`;
        }

        // Find primary key
        const pkColumn = table.schemaInfo?.find((c) => c.is_primary_key);
        if (pkColumn) {
          output += `\nPrimary Key: ${pkColumn.column_name}`;
        }

        // Build columns section with rich metadata
        output += '\nColumns:';
        for (const col of table.schemaInfo || []) {
          output += this.formatColumn(col);
        }

        // Add relationships section
        const tableRels = relationships.filter(
          (r) => r.from_table === table.tableName || r.to_table === table.tableName
        );
        if (tableRels.length > 0) {
          output += '\nRelationships:';
          for (const rel of tableRels) {
            const direction =
              rel.from_table === table.tableName
                ? `${rel.from_table}.${rel.from_column} → ${rel.to_table}.${rel.to_column}`
                : `${rel.from_table}.${rel.from_column} → ${rel.to_table}.${rel.to_column}`;
            output += `\n  - ${direction}`;
          }
        }

        return output;
      })
      .join('\n\n');
  }

  formatColumn(col) {
    let colInfo = `\n  - ${col.column_name}: ${col.data_type}`;

    // Nullability
    if (col.is_nullable === 'NO' || col.is_nullable === false) {
      colInfo += ' (NOT NULL)';
    }

    // Semantic type badge
    if (col.semantic_type) {
      colInfo += ` [${col.semantic_type}]`;
    }

    // Foreign key reference
    if (col.foreign_key_ref) {
      colInfo += ` [FK → ${col.foreign_key_ref}]`;
    }

    // YYMMDD date format annotation
    if (col.column_name.toLowerCase().includes('yymmdd')) {
      colInfo += ' [DATE as YYMMDD integer, e.g., 260114 = 2026-01-14]';
    }

    // Aggregation hint
    if (col.aggregation_hint && col.aggregation_hint !== 'NONE') {
      colInfo += ` [${col.aggregation_hint} candidate]`;
    }

    // Sample values for categorical columns
    if (col.sample_values?.length > 0) {
      const samples = col.sample_values.slice(0, 5);
      colInfo += ` Values: [${samples.map((v) => `'${v}'`).join(', ')}]`;
    }

    // Column description
    if (col.column_description) {
      colInfo += ` - ${col.column_description}`;
    }

    return colInfo;
  }

  /**
   * Get relationships for given tables from database
   */
  async getRelationships(databaseConfigId, tableNames) {
    if (!tableNames || tableNames.length === 0) {
      return [];
    }

    const result = await database.query(
      `SELECT from_table, from_column, to_table, to_column, relationship_type, cardinality
       FROM table_relationships
       WHERE database_config_id = $1
         AND (from_table = ANY($2) OR to_table = ANY($2))`,
      [databaseConfigId, tableNames]
    );

    return result.rows;
  }

  /**
   * Get enhanced column metadata for tables
   */
  async getEnhancedColumnMetadata(tableSchemaIds) {
    if (!tableSchemaIds || tableSchemaIds.length === 0) {
      return {};
    }

    const result = await database.query(
      `SELECT
         table_schema_id,
         column_name,
         column_description,
         data_type,
         is_nullable,
         is_primary_key,
         foreign_key_ref,
         semantic_type,
         aggregation_hint,
         sample_values
       FROM column_metadata
       WHERE table_schema_id = ANY($1)`,
      [tableSchemaIds]
    );

    // Group by table_schema_id
    const metadataMap = {};
    for (const row of result.rows) {
      if (!metadataMap[row.table_schema_id]) {
        metadataMap[row.table_schema_id] = [];
      }
      metadataMap[row.table_schema_id].push(row);
    }

    return metadataMap;
  }

  /**
   * Enrich table schema info with column metadata
   */
  enrichTableSchema(table, columnMetadata) {
    const metadata = columnMetadata[table.id] || [];

    // Create lookup map for column metadata
    const metadataMap = {};
    for (const col of metadata) {
      metadataMap[col.column_name] = col;
    }

    // Enrich schema info with metadata
    const enrichedSchemaInfo = (table.schemaInfo || []).map((col) => {
      const colMeta = metadataMap[col.column_name] || {};
      return {
        ...col,
        is_primary_key: colMeta.is_primary_key || false,
        foreign_key_ref: colMeta.foreign_key_ref || null,
        semantic_type: colMeta.semantic_type || null,
        aggregation_hint: colMeta.aggregation_hint || null,
        sample_values: colMeta.sample_values || null,
        column_description: colMeta.column_description || col.column_description || null,
      };
    });

    return {
      ...table,
      schemaInfo: enrichedSchemaInfo,
    };
  }

  /**
   * Build compact join path for LLM
   * e.g., "orders → order_items (via order_id) → products (via product_id)"
   */
  buildJoinPath(relationships, startTable, endTable) {
    // Simple BFS to find path
    const visited = new Set();
    const queue = [[startTable, []]];

    while (queue.length > 0) {
      const [current, path] = queue.shift();

      if (current === endTable) {
        return path;
      }

      if (visited.has(current)) continue;
      visited.add(current);

      // Find connected tables
      const connected = relationships.filter(
        (r) => r.from_table === current || r.to_table === current
      );

      for (const rel of connected) {
        const nextTable = rel.from_table === current ? rel.to_table : rel.from_table;
        const joinCol = rel.from_table === current ? rel.from_column : rel.to_column;

        if (!visited.has(nextTable)) {
          queue.push([
            nextTable,
            [...path, { from: current, to: nextTable, via: joinCol }],
          ]);
        }
      }
    }

    return null; // No path found
  }

  /**
   * Generate JOIN clause suggestions based on relationships
   */
  generateJoinSuggestions(tables, relationships) {
    const suggestions = [];
    const tableSet = new Set(tables.map((t) => t.tableName));

    for (const rel of relationships) {
      if (tableSet.has(rel.from_table) && tableSet.has(rel.to_table)) {
        suggestions.push(
          `JOIN ${rel.to_table} ON ${rel.from_table}.${rel.from_column} = ${rel.to_table}.${rel.to_column}`
        );
      }
    }

    return suggestions;
  }

  /**
   * Extract sample values for categorical columns
   * Called during indexing or on-demand
   */
  async extractSampleValues(pool, tableName, columnName, limit = 10) {
    try {
      const query = `
        SELECT DISTINCT "${columnName}"
        FROM "${tableName}"
        WHERE "${columnName}" IS NOT NULL
        LIMIT ${limit}
      `;
      const result = await pool.query(query);
      return result.rows.map((r) => r[columnName]);
    } catch (error) {
      logger.warn(`Failed to extract sample values for ${tableName}.${columnName}:`, error);
      return [];
    }
  }

  /**
   * Update sample values for a column
   */
  async updateSampleValues(tableSchemaId, columnName, sampleValues) {
    await database.query(
      `UPDATE column_metadata
       SET sample_values = $1, updated_at = CURRENT_TIMESTAMP
       WHERE table_schema_id = $2 AND column_name = $3`,
      [JSON.stringify(sampleValues), tableSchemaId, columnName]
    );
  }
}

export const schemaEnricher = new SchemaEnricher();
