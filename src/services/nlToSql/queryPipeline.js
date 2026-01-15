import { PromptTemplate } from '@langchain/core/prompts';
import { database } from '../../config/database.js';
import { embeddingService } from '../embeddingService.js';
import { logger } from '../../utils/logger.js';
import { ValidationError } from '../../utils/errors.js';

/**
 * Multi-stage query generation pipeline
 * Stage 1: Query Planning
 * Stage 2: SQL Generation (with examples)
 * Stage 3: Self-Review
 * Stage 4: Validation (handled by RetryController)
 */
export class QueryPipeline {
  constructor(llmClient) {
    this.llmClient = llmClient;
    this.initializePrompts();
  }

  initializePrompts() {
    // Stage 1: Query Planning Prompt
    this.planningPrompt = PromptTemplate.fromTemplate(`
You are a SQL query planner for PostgreSQL. Create a step-by-step plan for the SQL query.

User Question: {question}
Additional Instructions: {instruction}

Query Analysis:
- Intent: {intent}
- Entities: {entities}
- Time Range: {timeRange}
- Time Range (YYMMDD): {timeRangeYYMMDD}
- Grouping: {grouping}
- Limit: {limit}

Database Schema:
{schema}

Table Relationships:
{relationships}

Create a JSON query plan with:
1. tables: List of tables needed (in JOIN order)
2. joins: List of JOIN conditions
3. select: Columns and aggregations to select
4. filters: WHERE conditions
5. groupBy: GROUP BY columns (if needed)
6. orderBy: ORDER BY columns (if needed)
7. limit: Result limit

IMPORTANT for YYMMDD date columns:
- Use 6-digit integers (e.g., 260114 for 2026-01-14)
- NEVER use 8-digit YYYYMMDD format

Output ONLY valid JSON:
`);

    // Stage 2: SQL Generation Prompt (enhanced)
    this.generationPrompt = PromptTemplate.fromTemplate(`
You are an expert PostgreSQL query generator.

Database Schema:
{schema}

Query Plan:
{queryPlan}

Similar Examples:
{examples}

CRITICAL DATE HANDLING (YYMMDD format):
- Columns with "yymmdd" store dates as 6-DIGIT integers
- Format: YYMMDD (e.g., 260114 = Jan 14, 2026)
- NEVER use 8-digit YYYYMMDD (20260114 is WRONG)
- NEVER compare with date strings like '2026-01-14'

Rules:
1. Generate ONLY the SQL query, no explanations
2. Use proper PostgreSQL syntax
3. Follow the query plan structure
4. Use table aliases for clarity
5. Only SELECT queries allowed
6. Always include LIMIT (use 100 if not specified)
7. For "daywise" grouping, GROUP BY the date column
8. For "top per day", use ROW_NUMBER() OVER (PARTITION BY date)

User Question: {question}
Additional Instructions: {instruction}

Time Range (YYMMDD if applicable): {timeRangeYYMMDD}

Corrective Feedback (if any):
{feedback}

SQL Query:
`);

    // Stage 3: Self-Review Prompt
    this.reviewPrompt = PromptTemplate.fromTemplate(`
You are a SQL query reviewer. Check if this SQL correctly answers the question.

User Question: {question}
Generated SQL:
{sql}

Query Plan:
{queryPlan}

Schema Context:
{schema}

Review checklist:
1. Does the SQL answer the exact question asked?
2. Are all required JOINs present with correct conditions?
3. Is GROUP BY correct for any aggregations?
4. Is ORDER BY correct for ranking/top-N questions?
5. Are date filters correctly applied (YYMMDD format)?
6. Does LIMIT match what was asked?

Respond with ONLY valid JSON:
{{
  "isCorrect": true/false,
  "confidence": 0.0-1.0,
  "issues": ["issue1", "issue2"],
  "suggestions": ["suggestion1"]
}}
`);
  }

  /**
   * Main pipeline execution
   */
  async generate(params) {
    const {
      queryAnalysis,
      schemaContext,
      relationships,
      examples = [],
      feedback = '',
    } = params;

    try {
      // Stage 1: Query Planning
      const queryPlan = await this.planQuery(queryAnalysis, schemaContext, relationships);
      logger.info('Query plan generated', { queryPlan });

      // Stage 2: SQL Generation
      let sql = await this.generateSQL({
        queryAnalysis,
        schemaContext,
        queryPlan,
        examples,
        feedback,
      });

      // Stage 3: Self-Review (optional, can be skipped for speed)
      const reviewResult = await this.selfReview(
        sql,
        queryAnalysis,
        queryPlan,
        schemaContext
      );

      if (!reviewResult.isCorrect && reviewResult.confidence > 0.7) {
        // High confidence that something is wrong - regenerate
        const reviewFeedback = `Self-review found issues:\n- ${reviewResult.issues.join('\n- ')}\nSuggestions: ${reviewResult.suggestions.join(', ')}`;

        sql = await this.generateSQL({
          queryAnalysis,
          schemaContext,
          queryPlan,
          examples,
          feedback: reviewFeedback,
        });
      }

      return {
        sql,
        queryPlan,
        reviewResult,
      };
    } catch (error) {
      logger.error('Query pipeline failed:', error);
      throw error;
    }
  }

  /**
   * Stage 1: Generate query plan
   */
  async planQuery(queryAnalysis, schemaContext, relationships) {
    const relationshipsText =
      relationships && relationships.length > 0
        ? relationships
            .map((r) => `${r.from_table}.${r.from_column} → ${r.to_table}.${r.to_column}`)
            .join('\n')
        : 'None detected';

    const prompt = await this.planningPrompt.format({
      question: queryAnalysis.originalQuery,
      instruction: queryAnalysis.instruction || '',
      intent: queryAnalysis.primaryIntent?.name || 'Unknown',
      entities: queryAnalysis.entities?.map((e) => e.type).join(', ') || 'None',
      timeRange: queryAnalysis.timeRange
        ? JSON.stringify(queryAnalysis.timeRange)
        : 'None',
      timeRangeYYMMDD: queryAnalysis.timeRangeYYMMDD
        ? JSON.stringify(queryAnalysis.timeRangeYYMMDD)
        : 'None',
      grouping:
        queryAnalysis.grouping?.map((g) => g.dimension).join(', ') || 'None',
      limit: queryAnalysis.limit || 'Not specified',
      schema: schemaContext,
      relationships: relationshipsText,
    });

    const response = await this.llmClient.generateText(prompt);
    return this.parseJSON(response);
  }

  /**
   * Stage 2: Generate SQL from plan
   */
  async generateSQL(params) {
    const { queryAnalysis, schemaContext, queryPlan, examples, feedback } = params;

    const examplesText =
      examples.length > 0
        ? examples
            .map(
              (ex, i) =>
                `Example ${i + 1}:\nQuestion: ${ex.natural_query}\nSQL: ${ex.generated_sql}`
            )
            .join('\n\n')
        : 'No similar examples available';

    const prompt = await this.generationPrompt.format({
      schema: schemaContext,
      queryPlan: JSON.stringify(queryPlan, null, 2),
      examples: examplesText,
      question: queryAnalysis.originalQuery,
      instruction: queryAnalysis.instruction || '',
      timeRangeYYMMDD: queryAnalysis.timeRangeYYMMDD
        ? JSON.stringify(queryAnalysis.timeRangeYYMMDD)
        : 'None',
      feedback: feedback || 'None',
    });

    let sql = await this.llmClient.generateText(prompt);
    sql = this.sanitizeSQL(sql);

    return sql;
  }

  /**
   * Stage 3: Self-review generated SQL
   */
  async selfReview(sql, queryAnalysis, queryPlan, schemaContext) {
    try {
      const prompt = await this.reviewPrompt.format({
        question: queryAnalysis.originalQuery,
        sql,
        queryPlan: JSON.stringify(queryPlan, null, 2),
        schema: schemaContext,
      });

      const response = await this.llmClient.generateText(prompt);
      return this.parseJSON(response);
    } catch (error) {
      logger.warn('Self-review failed, skipping:', error);
      return { isCorrect: true, confidence: 0.5, issues: [], suggestions: [] };
    }
  }

  /**
   * Get similar examples for few-shot learning
   */
  async getSimilarExamples(query, databaseConfigId, limit = 3) {
    try {
      const queryEmbedding = await embeddingService.generateEmbedding(query);

      const result = await database.query(
        `SELECT natural_query, generated_sql, intent_type,
                1 - (embedding <=> $1::vector) AS similarity
         FROM query_examples
         WHERE database_config_id = $2
           AND was_successful = TRUE
           AND (feedback_score IS NULL OR feedback_score >= 4)
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [JSON.stringify(queryEmbedding), databaseConfigId, limit]
      );

      return result.rows;
    } catch (error) {
      logger.warn('Failed to get similar examples:', error);
      return [];
    }
  }

  /**
   * Store successful query as example for future learning
   */
  async storeSuccessfulQuery(params) {
    const { databaseConfigId, naturalQuery, sql, intentType, tablesUsed } = params;

    try {
      const embedding = await embeddingService.generateEmbedding(naturalQuery);

      await database.query(
        `INSERT INTO query_examples
         (database_config_id, natural_query, generated_sql, intent_type, tables_used, embedding, was_successful)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
        [
          databaseConfigId,
          naturalQuery,
          sql,
          intentType,
          JSON.stringify(tablesUsed),
          JSON.stringify(embedding),
        ]
      );
    } catch (error) {
      logger.warn('Failed to store query example:', error);
    }
  }

  sanitizeSQL(sql) {
    let cleaned = sql.replace(/```sql\n?/gi, '').replace(/```\n?/g, '');
    cleaned = cleaned.trim();
    if (cleaned.endsWith(';')) {
      cleaned = cleaned.slice(0, -1);
    }
    return cleaned;
  }

  parseJSON(text) {
    // Remove markdown code blocks if present
    let cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '');
    cleaned = cleaned.trim();

    // Find JSON object boundaries
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
      throw new ValidationError('Invalid JSON response from LLM');
    }

    const jsonStr = cleaned.slice(start, end + 1);

    try {
      return JSON.parse(jsonStr);
    } catch (error) {
      throw new ValidationError('Failed to parse JSON response: ' + error.message);
    }
  }
}
