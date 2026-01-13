import { PromptTemplate } from '@langchain/core/prompts';
import { embeddingService } from './embeddingService.js';
import { logger } from '../utils/logger.js';
import { ExternalServiceError, ValidationError } from '../utils/errors.js';
import { llmClient } from './llmClient.js';

class NLToSQLService {
  constructor() {
    this.sqlPromptTemplate = PromptTemplate.fromTemplate(`
You are an expert PostgreSQL query generator. Convert the following natural language question into a valid PostgreSQL query.

Database Schema:
{schema}

Important Rules:
1. Generate ONLY the SQL query without any explanation
2. Use proper PostgreSQL syntax
3. Include appropriate WHERE clauses, JOINs, GROUP BY, ORDER BY as needed
4. For aggregations or analytics questions, include proper aggregate functions
5. Always use table aliases for clarity
6. Return only SELECT queries for safety
7. Do not include any markdown formatting or code blocks

Natural Language Question: {question}

SQL Query:`);
    this.intentPromptTemplate = PromptTemplate.fromTemplate(`
Analyze this query and determine the best visualization type.

Query: {question}

Return ONLY one of these options:
- table (for simple data listing)
- bar_chart (for comparisons)
- line_chart (for trends over time)
- pie_chart (for proportions)
- number (for single values or aggregates)

Visualization Type:`);
  }

  async convertToSQL(naturalQuery, databaseConfigId, organizationId) {
    try {
      const queryEmbedding = await embeddingService.generateEmbedding(naturalQuery);
      const relevantTables = await embeddingService.findRelevantTablesByEmbedding(
        queryEmbedding,
        databaseConfigId,
        10
      );

      if (relevantTables.length === 0) {
        throw new ValidationError(
          'No relevant tables found for your query. Please ensure the database has been indexed.'
        );
      }

      const schemaContext = this.buildSchemaContext(relevantTables);

      const prompt = await this.sqlPromptTemplate.format({
        schema: schemaContext,
        question: naturalQuery,
      });

      let sqlQuery = await llmClient.generateText(prompt);

      sqlQuery = this.sanitizeSQL(sqlQuery);

      this.validateSQL(sqlQuery);

      logger.info('SQL generated successfully', {
        naturalQuery,
        sqlQuery,
        databaseConfigId,
        organizationId,
        relevantTables: relevantTables.map((table) => table.tableName),
      });

      return {
        sql: sqlQuery,
        relevantTables: relevantTables.map((t) => t.tableName),
      };
    } catch (error) {
      logger.error('NL to SQL conversion failed:', error);
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ExternalServiceError('Failed to generate SQL query');
    }
  }

  buildSchemaContext(relevantTables) {
    return relevantTables
      .map((table) => {
        let tableHeader = `Table: ${table.tableName}`;
        if (table.tableDescription) {
          tableHeader += ` - ${table.tableDescription}`;
        }

        const columns = table.schemaInfo
          .map((col) => {
            let columnInfo = `  - ${col.column_name}: ${col.data_type}${col.is_nullable === 'NO' ? ' (NOT NULL)' : ''}`;
            if (col.column_description) {
              columnInfo += ` - ${col.column_description}`;
            }
            return columnInfo;
          })
          .join('\n');

        return `${tableHeader}\nColumns:\n${columns}`;
      })
      .join('\n\n');
  }

  sanitizeSQL(sql) {
    // Remove markdown code blocks
    sql = sql.replace(/```sql\n?/g, '').replace(/```\n?/g, '');
    sql = sql.trim();

    // Remove trailing semicolon
    if (sql.endsWith(';')) {
      sql = sql.slice(0, -1);
    }

    return sql;
  }

  stripSQLComments(sql) {
    // Remove single-line comments (-- comment)
    let stripped = sql.replace(/--[^\n]*/g, '');
    // Remove multi-line comments (/* comment */)
    stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, '');
    return stripped;
  }

  validateSQL(sql) {
    // Strip comments before validation to prevent bypass attempts
    const strippedSQL = this.stripSQLComments(sql);
    const normalizedSQL = strippedSQL.toLowerCase().replace(/\s+/g, ' ').trim();

    // Check for multiple statements (potential injection)
    if (sql.includes(';')) {
      throw new ValidationError('Multiple SQL statements are not allowed');
    }

    // Dangerous keywords that should never appear as SQL commands
    // Using word boundaries to avoid false positives (e.g., "dropdown" contains "drop")
    const dangerousKeywords = [
      'drop',
      'delete',
      'truncate',
      'insert',
      'update',
      'alter',
      'create',
      'grant',
      'revoke',
      'exec',
      'execute',
      'xp_',
      'sp_',
      'into outfile',
      'into dumpfile',
      'load_file',
      'pg_read_file',
      'pg_write_file',
      'copy',
    ];

    for (const keyword of dangerousKeywords) {
      // Use word boundary regex to match whole words only
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(normalizedSQL)) {
        throw new ValidationError(
          `Query contains forbidden operation: ${keyword.toUpperCase()}`
        );
      }
    }

    // Ensure query starts with SELECT (after stripping whitespace)
    if (!normalizedSQL.startsWith('select ') && normalizedSQL !== 'select') {
      throw new ValidationError('Only SELECT queries are allowed');
    }

    // Check for UNION-based injection attempts with other statement types
    const unionPattern = /\bunion\b.*\b(insert|update|delete|drop|alter|create)\b/i;
    if (unionPattern.test(normalizedSQL)) {
      throw new ValidationError('Invalid UNION query detected');
    }
  }

  async analyzeQueryIntent(naturalQuery) {
    try {
      const prompt = await this.intentPromptTemplate.format({
        question: naturalQuery,
      });
      const visualizationType = (await llmClient.generateText(prompt)).toLowerCase();

      const validTypes = ['table', 'bar_chart', 'line_chart', 'pie_chart', 'number'];
      if (validTypes.includes(visualizationType)) {
        return visualizationType;
      }

      return 'table';
    } catch (error) {
      logger.error('Query intent analysis failed:', error);
      return 'table';
    }
  }
}

export const nlToSqlService = new NLToSQLService();
