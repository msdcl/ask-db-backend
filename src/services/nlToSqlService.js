import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { config } from '../config/env.js';
import { embeddingService } from './embeddingService.js';
import { logger } from '../utils/logger.js';
import { ExternalServiceError, ValidationError } from '../utils/errors.js';

class NLToSQLService {
  constructor() {
    this.llm = new ChatOpenAI({
      openAIApiKey: config.openai.apiKey,
      modelName: 'gpt-4-turbo-preview',
      temperature: 0,
    });

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
  }

  async convertToSQL(naturalQuery, databaseConfigId, organizationId) {
    try {
      const relevantTables = await embeddingService.findRelevantTables(
        naturalQuery,
        databaseConfigId,
        3
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

      const response = await this.llm.invoke(prompt);
      let sqlQuery = response.content.trim();

      sqlQuery = this.sanitizeSQL(sqlQuery);

      this.validateSQL(sqlQuery);

      logger.info('SQL generated successfully', {
        naturalQuery,
        sqlQuery,
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
        const columns = table.schemaInfo
          .map(
            (col) =>
              `  - ${col.column_name}: ${col.data_type}${col.is_nullable === 'NO' ? ' (NOT NULL)' : ''}`
          )
          .join('\n');

        return `Table: ${table.tableName}\nColumns:\n${columns}`;
      })
      .join('\n\n');
  }

  sanitizeSQL(sql) {
    sql = sql.replace(/```sql\n?/g, '').replace(/```\n?/g, '');
    sql = sql.trim();

    if (sql.endsWith(';')) {
      sql = sql.slice(0, -1);
    }

    return sql;
  }

  validateSQL(sql) {
    const lowerSQL = sql.toLowerCase();

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
    ];

    for (const keyword of dangerousKeywords) {
      if (lowerSQL.includes(keyword)) {
        throw new ValidationError(
          `Query contains forbidden operation: ${keyword.toUpperCase()}`
        );
      }
    }

    if (!lowerSQL.startsWith('select')) {
      throw new ValidationError('Only SELECT queries are allowed');
    }
  }

  async analyzeQueryIntent(naturalQuery) {
    try {
      const analysisPrompt = `Analyze this query and determine the best visualization type.

Query: ${naturalQuery}

Return ONLY one of these options:
- table (for simple data listing)
- bar_chart (for comparisons)
- line_chart (for trends over time)
- pie_chart (for proportions)
- number (for single values or aggregates)

Visualization Type:`;

      const response = await this.llm.invoke(analysisPrompt);
      const visualizationType = response.content.trim().toLowerCase();

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
