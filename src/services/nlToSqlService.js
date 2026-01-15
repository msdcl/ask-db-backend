import { PromptTemplate } from '@langchain/core/prompts';
import { embeddingService } from './embeddingService.js';
import { databaseService } from './databaseService.js';
import { logger } from '../utils/logger.js';
import { ExternalServiceError, ValidationError } from '../utils/errors.js';
import { llmClient } from './llmClient.js';

// Original components (kept for backward compatibility)
import { PatternLibrary } from './nlToSql/patternLibrary.js';
import { IntentPlannerChain } from './nlToSql/intentPlannerChain.js';
import { SqlGeneratorChain } from './nlToSql/sqlGeneratorChain.js';
import { SqlSemanticValidator } from './nlToSql/sqlSemanticValidator.js';
import { RetryController } from './nlToSql/retryController.js';
import { ExplainValidator } from './nlToSql/explainValidator.js';

// New enhanced components
import { QueryAnalyzer } from './nlToSql/queryAnalyzer.js';
import { TableRetriever } from './nlToSql/tableRetriever.js';
import { SchemaEnricher } from './nlToSql/schemaEnricher.js';
import { QueryPipeline } from './nlToSql/queryPipeline.js';
import { ComprehensiveValidator } from './nlToSql/comprehensiveValidator.js';

class NLToSQLService {
  constructor() {
    // Original components
    this.patternLibrary = new PatternLibrary();
    this.intentPlannerChain = new IntentPlannerChain(llmClient);
    this.sqlGeneratorChain = new SqlGeneratorChain(llmClient);
    this.semanticValidator = new SqlSemanticValidator();
    this.explainValidator = new ExplainValidator(databaseService);
    this.retryController = new RetryController(
      this.sqlGeneratorChain,
      this.semanticValidator,
      this.explainValidator,
      2
    );

    // New enhanced components
    this.queryAnalyzer = new QueryAnalyzer(llmClient);
    this.tableRetriever = new TableRetriever({
      minSimilarity: 0.25,
      maxTables: 15,
      maxFKHops: 2,
    });
    this.schemaEnricher = new SchemaEnricher();
    this.queryPipeline = new QueryPipeline(llmClient);
    this.comprehensiveValidator = new ComprehensiveValidator(databaseService);

    // Use enhanced mode by default
    this.useEnhancedMode = true;

    this.intentPromptTemplate = PromptTemplate.fromTemplate(`
Analyze this query and determine the best visualization type.

Query: {question}
Additional User Instructions : {instruction}

Return ONLY one of these options:
- table (for simple data listing)
- bar_chart (for comparisons)
- line_chart (for trends over time)
- pie_chart (for proportions)
- number (for single values or aggregates)

Visualization Type:`);
  }

  /**
   * Main entry point for asking questions
   */
  async askQuestion(naturalQuery, databaseConfigId, organizationId, instruction = '') {
    const convertMethod = this.useEnhancedMode
      ? this.convertToSQLEnhanced.bind(this)
      : this.convertToSQL.bind(this);

    const { sql, relevantTables, intent, queryAnalysis } = await convertMethod(
      naturalQuery,
      databaseConfigId,
      organizationId,
      instruction
    );

    try {
      const queryResult = await databaseService.executeQuery(
        databaseConfigId,
        organizationId,
        sql
      );

      // Store successful query for future learning (enhanced mode only)
      if (this.useEnhancedMode && queryResult.rowCount > 0) {
        this.storeSuccessfulQuery(
          databaseConfigId,
          naturalQuery,
          sql,
          queryAnalysis,
          relevantTables
        ).catch((err) => logger.warn('Failed to store query example:', err));
      }

      return {
        intent,
        sql,
        result: queryResult.data,
        rowCount: queryResult.rowCount,
        relevantTables,
        queryAnalysis: this.useEnhancedMode ? queryAnalysis : undefined,
      };
    } catch (error) {
      error.generatedSql = sql;
      throw error;
    }
  }

  /**
   * ENHANCED: Convert natural language to SQL using full pipeline
   */
  async convertToSQLEnhanced(naturalQuery, databaseConfigId, organizationId, instruction = '') {
    try {
      // Step 1: Analyze the query
      const queryAnalysis = await this.queryAnalyzer.analyze(naturalQuery, instruction);
      logger.info('Query analyzed', {
        intent: queryAnalysis.primaryIntent?.name,
        entities: queryAnalysis.entities.map((e) => e.type),
        timeRange: queryAnalysis.timeRange?.type,
      });

      // Step 2: Retrieve relevant tables using multi-strategy approach
      const { tables: relevantTables, relationships, retrievalStats } =
        await this.tableRetriever.retrieveTables(queryAnalysis, databaseConfigId);

      if (relevantTables.length === 0) {
        throw new ValidationError(
          'No relevant tables found for your query. Please ensure the database has been indexed.'
        );
      }

      logger.info('Tables retrieved', {
        count: relevantTables.length,
        tables: relevantTables.map((t) => t.tableName),
        stats: retrievalStats,
      });

      // Step 3: Build rich schema context
      const schemaContext = this.schemaEnricher.buildSchemaContext(
        relevantTables,
        relationships
      );

      // Step 4: Get similar examples for few-shot learning
      const examples = await this.queryPipeline.getSimilarExamples(
        naturalQuery,
        databaseConfigId,
        3
      );

      // Step 5: Generate SQL with multi-stage pipeline
      let sql;
      let queryPlan;
      let retryCount = 0;
      const maxRetries = 2;

      while (retryCount <= maxRetries) {
        try {
          const pipelineResult = await this.queryPipeline.generate({
            queryAnalysis,
            schemaContext,
            relationships,
            examples,
            feedback: retryCount > 0 ? this.lastValidationFeedback : '',
          });

          sql = pipelineResult.sql;
          queryPlan = pipelineResult.queryPlan;

          // Step 6: Comprehensive validation
          const validationResult = await this.comprehensiveValidator.validate(
            sql,
            queryAnalysis,
            schemaContext,
            { databaseConfigId, organizationId }
          );

          if (validationResult.isValid) {
            // Log warnings if any
            if (validationResult.warnings.length > 0) {
              logger.warn('SQL generated with warnings', {
                warnings: validationResult.warnings,
              });
            }
            break;
          }

          // Validation failed - prepare for retry
          this.lastValidationFeedback =
            this.comprehensiveValidator.buildFeedback(validationResult);
          retryCount++;

          if (retryCount > maxRetries) {
            // Use the last generated SQL even if validation failed
            logger.warn('SQL validation failed after retries', {
              errors: validationResult.errors,
            });
            break;
          }

          logger.info('Retrying SQL generation', {
            attempt: retryCount,
            errors: validationResult.errors,
          });
        } catch (pipelineError) {
          if (retryCount >= maxRetries) {
            throw pipelineError;
          }
          retryCount++;
          this.lastValidationFeedback = `Pipeline error: ${pipelineError.message}`;
        }
      }

      // Ensure SQL has LIMIT
      sql = this.ensureLimit(sql);

      logger.info('SQL generated successfully (enhanced)', {
        naturalQuery,
        sql,
        databaseConfigId,
        relevantTables: relevantTables.map((t) => t.tableName),
        intent: queryAnalysis.primaryIntent?.name,
      });

      return {
        sql,
        relevantTables: relevantTables.map((t) => t.tableName),
        intent: queryPlan,
        queryAnalysis,
      };
    } catch (error) {
      logger.error('Enhanced NL to SQL conversion failed:', error);

      // Fallback to original method on error
      if (this.useEnhancedMode) {
        logger.info('Falling back to original conversion method');
        try {
          return await this.convertToSQL(
            naturalQuery,
            databaseConfigId,
            organizationId,
            instruction
          );
        } catch (fallbackError) {
          logger.error('Fallback also failed:', fallbackError);
        }
      }

      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ExternalServiceError('Failed to generate SQL query');
    }
  }

  /**
   * ORIGINAL: Convert natural language to SQL (kept for backward compatibility)
   */
  async convertToSQL(naturalQuery, databaseConfigId, organizationId, instruction = '') {
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
      const detectedPatterns = this.patternLibrary.detectPatterns({
        question: naturalQuery,
        instruction,
      });
      const patternHints = detectedPatterns.length
        ? detectedPatterns.map((pattern) => `Detected: ${pattern.name}`).join('\n')
        : 'None';
      const patternSnippets = this.patternLibrary.buildSnippetBlock(detectedPatterns);

      let intent = await this.intentPlannerChain.plan({
        question: naturalQuery,
        instruction,
        schema: schemaContext,
        patternHints,
      });

      if (
        !intent.top_k_per_group &&
        this.patternLibrary.hasTopKPerGroup(detectedPatterns)
      ) {
        intent = { ...intent, top_k_per_group: 1 };
      }

      const sqlQuery = await this.retryController.generateWithRetry(
        {
          question: naturalQuery,
          instruction,
          schema: schemaContext,
          schemaObjects: relevantTables,
          intent,
          patternSnippets,
        },
        { databaseConfigId, organizationId }
      );

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
        intent,
      };
    } catch (error) {
      logger.error('NL to SQL conversion failed:', error);
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ExternalServiceError('Failed to generate SQL query');
    }
  }

  /**
   * Build schema context with enhanced metadata
   */
  buildSchemaContext(relevantTables) {
    return relevantTables
      .map((table) => {
        let tableHeader = `Table: ${table.tableName}`;
        if (table.tableDescription) {
          tableHeader += ` - ${table.tableDescription}`;
        }

        const columns = (table.schemaInfo || [])
          .map((col) => {
            let columnInfo = `  - ${col.column_name}: ${col.data_type}`;
            columnInfo += col.is_nullable === 'NO' ? ' (NOT NULL)' : '';

            // Add semantic type if available
            if (col.semantic_type) {
              columnInfo += ` [${col.semantic_type}]`;
            }

            // Add FK reference if available
            if (col.foreign_key_ref) {
              columnInfo += ` [FK → ${col.foreign_key_ref}]`;
            }

            // Annotate YYMMDD columns
            if (col.column_name.toLowerCase().includes('yymmdd')) {
              columnInfo += ' [DATE as YYMMDD integer, e.g., 260114 = 2026-01-14]';
            }

            // Add aggregation hint if available
            if (col.aggregation_hint && col.aggregation_hint !== 'NONE') {
              columnInfo += ` [${col.aggregation_hint} candidate]`;
            }

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

  /**
   * Ensure SQL has a LIMIT clause
   */
  ensureLimit(sql) {
    const normalized = sql.toLowerCase();
    if (!/\blimit\b/i.test(normalized)) {
      return `${sql} LIMIT 100`;
    }
    return sql;
  }

  /**
   * Store successful query for future learning
   */
  async storeSuccessfulQuery(
    databaseConfigId,
    naturalQuery,
    sql,
    queryAnalysis,
    relevantTables
  ) {
    try {
      await this.queryPipeline.storeSuccessfulQuery({
        databaseConfigId,
        naturalQuery,
        sql,
        intentType: queryAnalysis?.primaryIntent?.type || 'UNKNOWN',
        tablesUsed: relevantTables,
      });
    } catch (error) {
      // Non-blocking - just log
      logger.warn('Failed to store successful query:', error);
    }
  }

  /**
   * Analyze query for visualization type
   */
  async analyzeQueryIntent(naturalQuery, instruction = '') {
    try {
      // Use QueryAnalyzer for enhanced intent detection
      if (this.useEnhancedMode) {
        const analysis = await this.queryAnalyzer.analyze(naturalQuery, instruction);
        const intent = analysis.primaryIntent;

        if (intent) {
          // Map intent to visualization type
          if (intent.type === 'TREND' || intent.type === 'GROWTH') {
            return 'line_chart';
          }
          if (intent.type === 'TOP_N' || intent.type === 'RANKING' || intent.type === 'COMPARISON') {
            return 'bar_chart';
          }
          if (intent.type === 'TOTAL' || intent.type === 'COUNT' || intent.type === 'AVERAGE') {
            return analysis.grouping?.length > 0 ? 'pie_chart' : 'number';
          }
        }
      }

      // Fallback to LLM-based detection
      const instructionContext = instruction?.trim() ? instruction.trim() : 'None';
      const prompt = await this.intentPromptTemplate.format({
        question: naturalQuery,
        instruction: instructionContext,
      });
      const visualizationType = (await llmClient.generateText(prompt)).toLowerCase().trim();

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

  /**
   * Toggle enhanced mode
   */
  setEnhancedMode(enabled) {
    this.useEnhancedMode = enabled;
    logger.info(`NL-to-SQL enhanced mode ${enabled ? 'enabled' : 'disabled'}`);
  }
}

export const nlToSqlService = new NLToSQLService();
