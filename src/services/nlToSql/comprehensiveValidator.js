import { logger } from '../../utils/logger.js';
import { ValidationError } from '../../utils/errors.js';

/**
 * Comprehensive SQL Validator
 *
 * Layers:
 * 1. Syntax Validation (EXPLAIN)
 * 2. Semantic Validation (structure checks)
 * 3. Business Logic Validation (intent matching)
 * 4. Result Schema Validation (output expectations)
 * 5. Performance Validation (cost estimation)
 */
export class ComprehensiveValidator {
  constructor(databaseService = null) {
    this.databaseService = databaseService;
  }

  /**
   * Run all validation layers
   */
  async validate(sql, queryAnalysis, schemaContext, dbContext = null) {
    const results = {
      isValid: true,
      errors: [],
      warnings: [],
      validationDetails: {},
    };

    // Layer 1: Syntax Validation (requires DB connection)
    if (this.databaseService && dbContext) {
      const syntaxResult = await this.validateSyntax(sql, dbContext);
      results.validationDetails.syntax = syntaxResult;

      if (!syntaxResult.isValid) {
        results.isValid = false;
        results.errors.push(...syntaxResult.errors);
        return results; // Early exit on syntax errors
      }
      results.warnings.push(...syntaxResult.warnings);
    }

    // Layer 2: Semantic Validation
    const semanticResult = this.validateSemantics(sql, queryAnalysis, schemaContext);
    results.validationDetails.semantic = semanticResult;
    results.errors.push(...semanticResult.errors);
    results.warnings.push(...semanticResult.warnings);

    // Layer 3: Business Logic Validation
    const businessResult = this.validateBusinessLogic(sql, queryAnalysis);
    results.validationDetails.business = businessResult;
    results.errors.push(...businessResult.errors);
    results.warnings.push(...businessResult.warnings);

    // Layer 4: Result Schema Validation
    const schemaResult = this.validateResultSchema(sql, queryAnalysis);
    results.validationDetails.resultSchema = schemaResult;
    results.warnings.push(...schemaResult.warnings);

    // Layer 5: Date Format Validation (critical for YYMMDD)
    const dateResult = this.validateDateFormats(sql, schemaContext);
    results.validationDetails.dateFormat = dateResult;
    results.errors.push(...dateResult.errors);
    results.warnings.push(...dateResult.warnings);

    results.isValid = results.errors.length === 0;
    return results;
  }

  /**
   * Layer 1: Syntax Validation using EXPLAIN
   */
  async validateSyntax(sql, dbContext) {
    const errors = [];
    const warnings = [];

    try {
      const explainSql = `EXPLAIN (FORMAT JSON) ${sql}`;
      const result = await this.databaseService.executeQuery(
        dbContext.databaseConfigId,
        dbContext.organizationId,
        explainSql
      );

      const plan = result.data[0]['QUERY PLAN'][0]['Plan'];

      // Check for sequential scans on large tables
      const seqScans = this.findNodesByType(plan, 'Seq Scan');
      for (const scan of seqScans) {
        if (scan['Plan Rows'] > 10000) {
          warnings.push(
            `Sequential scan on "${scan['Relation Name']}" (est. ${scan['Plan Rows']} rows). Consider adding index or WHERE clause.`
          );
        }
      }

      // Check for nested loops without conditions
      const nestedLoops = this.findNodesByType(plan, 'Nested Loop');
      for (const loop of nestedLoops) {
        if (!loop['Join Filter'] && !loop['Index Cond']) {
          warnings.push(
            'Nested loop join without filter detected. May indicate missing join condition.'
          );
        }
      }

      // Check estimated result size
      if (plan['Plan Rows'] > 100000) {
        warnings.push(
          `Large result set expected (${plan['Plan Rows']} rows). Consider adding more filters.`
        );
      }

      return { isValid: true, errors, warnings, plan };
    } catch (error) {
      const errorMessage = this.extractErrorMessage(error);
      errors.push(`Query syntax error: ${errorMessage}`);
      return { isValid: false, errors, warnings, plan: null };
    }
  }

  /**
   * Layer 2: Semantic Validation
   */
  validateSemantics(sql, queryAnalysis, schemaContext) {
    const errors = [];
    const warnings = [];
    const normalized = sql.toLowerCase();

    // Check: GROUP BY consistency with intent
    if (queryAnalysis?.grouping?.length > 0) {
      const hasGroupBy = /\bgroup\s+by\b/i.test(normalized);
      const hasPartitionBy = /\bpartition\s+by\b/i.test(normalized);

      if (!hasGroupBy && !hasPartitionBy) {
        errors.push(
          `Query should group by [${queryAnalysis.grouping.map((g) => g.dimension).join(', ')}] but no GROUP BY or PARTITION BY found.`
        );
      }
    }

    // Check: Top-K per group requires window function
    if (queryAnalysis?.primaryIntent?.type === 'TOP_N' && queryAnalysis?.grouping?.length > 0) {
      const hasRowNumber = /row_number\s*\(/i.test(normalized);
      const hasRank = /\brank\s*\(/i.test(normalized);
      const hasDistinctOn = /\bdistinct\s+on\s*\(/i.test(normalized);

      if (!hasRowNumber && !hasRank && !hasDistinctOn) {
        warnings.push(
          'Top-N with grouping detected. Consider using ROW_NUMBER() OVER (PARTITION BY ...) for correct results.'
        );
      }
    }

    // Check: Aggregates without GROUP BY
    const aggregates = ['count(', 'sum(', 'avg(', 'max(', 'min('];
    const hasAggregate = aggregates.some((agg) => normalized.includes(agg));
    const hasGroupBy = /\bgroup\s+by\b/i.test(normalized);

    if (hasAggregate && !hasGroupBy) {
      const selectMatch = normalized.match(/select\s+(.*?)\s+from/is);
      if (selectMatch) {
        const selectClause = selectMatch[1];
        const columns = selectClause.split(',');
        const nonAggregated = columns.filter((col) => {
          const trimmed = col.trim();
          return (
            !aggregates.some((agg) => trimmed.includes(agg)) &&
            !trimmed.includes('*') &&
            !/^\d+$/.test(trimmed) &&
            !/^'.*'$/.test(trimmed) &&
            trimmed.length > 0
          );
        });

        if (nonAggregated.length > 0) {
          errors.push(
            'Query has aggregates with non-aggregated columns but no GROUP BY. This will cause an error.'
          );
        }
      }
    }

    // Check: JOIN conditions present
    const joinCount = (normalized.match(/\bjoin\b/g) || []).length;
    const onCount = (normalized.match(/\bon\b/g) || []).length;

    if (joinCount > onCount) {
      errors.push('Some JOIN clauses may be missing ON conditions.');
    }

    return { errors, warnings };
  }

  /**
   * Layer 3: Business Logic Validation
   */
  validateBusinessLogic(sql, queryAnalysis) {
    const errors = [];
    const warnings = [];
    const normalized = sql.toLowerCase();

    if (!queryAnalysis) {
      return { errors, warnings };
    }

    const intent = queryAnalysis.primaryIntent;

    // Check: Aggregation intents should have aggregates
    if (intent?.requiresAggregate) {
      const hasAggregate = /\b(sum|count|avg|max|min)\s*\(/i.test(normalized);
      if (!hasAggregate) {
        errors.push(
          `Intent "${intent.name}" requires aggregation but no aggregate function found.`
        );
      }
    }

    // Check: Ranking intents should have ORDER BY
    if (intent?.requiresOrderBy) {
      const hasOrderBy = /\border\s+by\b/i.test(normalized);
      if (!hasOrderBy) {
        errors.push(
          `Intent "${intent.name}" requires ordering but no ORDER BY clause found.`
        );
      }

      // Check order direction
      if (intent.orderDirection === 'DESC') {
        const hasDesc = /\bdesc\b/i.test(normalized);
        if (!hasDesc) {
          warnings.push(
            `"Top" queries typically need DESC ordering. Currently using ASC or default.`
          );
        }
      }
    }

    // Check: Time-filtered queries should have date filter
    if (queryAnalysis.timeRange) {
      const hasDateFilter =
        /where.*\b(date|_at|created|updated|yymmdd)\b/i.test(normalized) ||
        /\b\d{6}\b/.test(sql); // 6-digit YYMMDD

      if (!hasDateFilter) {
        warnings.push(
          'Time range specified in query but no apparent date filter in SQL.'
        );
      }
    }

    // Check: Limit should match intent
    if (queryAnalysis.limit) {
      const limitMatch = normalized.match(/limit\s+(\d+)/i);
      if (limitMatch) {
        const sqlLimit = parseInt(limitMatch[1], 10);
        if (sqlLimit !== queryAnalysis.limit && queryAnalysis.limit < sqlLimit) {
          warnings.push(
            `Asked for ${queryAnalysis.limit} results but SQL has LIMIT ${sqlLimit}.`
          );
        }
      }
    }

    // Check: Grouping intents should have GROUP BY
    if (intent?.requiresGroupBy || queryAnalysis.grouping?.length > 0) {
      const hasGroupBy = /\bgroup\s+by\b/i.test(normalized);
      const hasPartitionBy = /\bpartition\s+by\b/i.test(normalized);

      if (!hasGroupBy && !hasPartitionBy) {
        errors.push(
          'Query requires grouping but no GROUP BY or PARTITION BY found.'
        );
      }
    }

    return { errors, warnings };
  }

  /**
   * Layer 4: Result Schema Validation
   */
  validateResultSchema(sql, queryAnalysis) {
    const warnings = [];
    const normalized = sql.toLowerCase();

    if (!queryAnalysis) {
      return { warnings };
    }

    // Extract SELECT columns
    const selectMatch = normalized.match(/select\s+(.*?)\s+from/is);
    if (!selectMatch) {
      return { warnings };
    }

    const selectClause = selectMatch[1].toLowerCase();

    // Check: Ranking queries should include the ranking metric
    if (
      queryAnalysis.primaryIntent?.type === 'TOP_N' ||
      queryAnalysis.primaryIntent?.type === 'RANKING'
    ) {
      const hasMetric =
        /\b(count|sum|avg|total|amount|quantity|revenue|sales)\b/i.test(selectClause);
      if (!hasMetric) {
        warnings.push(
          'Ranking query should include the metric being ranked in SELECT.'
        );
      }
    }

    // Check: Time series should include date column
    if (queryAnalysis.primaryIntent?.type === 'TREND') {
      const hasDateColumn = /\b(date|day|month|year|week|yymmdd)\b/i.test(selectClause);
      if (!hasDateColumn) {
        warnings.push('Trend query should include time dimension in SELECT.');
      }
    }

    // Check: Grouped queries should include grouping column
    if (queryAnalysis.grouping?.length > 0) {
      for (const group of queryAnalysis.grouping) {
        const hasGroupColumn = selectClause.includes(group.dimension.toLowerCase());
        if (!hasGroupColumn) {
          warnings.push(
            `Grouped by "${group.dimension}" but it may not be in SELECT clause.`
          );
        }
      }
    }

    return { warnings };
  }

  /**
   * Layer 5: Date Format Validation (YYMMDD specific)
   */
  validateDateFormats(sql, schemaContext) {
    const errors = [];
    const warnings = [];

    // Check for 8-digit YYYYMMDD format (common mistake)
    const eightDigitPattern = /\b(19|20)\d{6}\b/g;
    const matches = sql.match(eightDigitPattern);

    if (matches) {
      const uniqueMatches = [...new Set(matches)];
      errors.push(
        `Detected YYYYMMDD format values [${uniqueMatches.join(', ')}]. YYMMDD columns use 6-digit format (e.g., 260114 for 2026-01-14, NOT 20260114).`
      );
    }

    // Check for date string comparisons on YYMMDD columns
    const yymmddColumns = this.extractYYMMDDColumns(schemaContext);

    for (const colName of yymmddColumns) {
      const dateStringPattern = new RegExp(
        `${colName}\\s*[=<>!]+\\s*'\\d{4}-\\d{2}-\\d{2}'`,
        'i'
      );
      if (dateStringPattern.test(sql)) {
        errors.push(
          `Column "${colName}" is YYMMDD integer but compared with date string. Use integer comparison (e.g., 260114).`
        );
      }
    }

    // Check for valid YYMMDD range (6-digit numbers)
    const sixDigitNumbers = sql.match(/\b\d{6}\b/g);
    if (sixDigitNumbers) {
      for (const num of sixDigitNumbers) {
        const yy = parseInt(num.substring(0, 2), 10);
        const mm = parseInt(num.substring(2, 4), 10);
        const dd = parseInt(num.substring(4, 6), 10);

        if (mm < 1 || mm > 12) {
          warnings.push(
            `Value ${num} has invalid month (${mm}). YYMMDD format: YY=00-99, MM=01-12, DD=01-31.`
          );
        }
        if (dd < 1 || dd > 31) {
          warnings.push(
            `Value ${num} has invalid day (${dd}). YYMMDD format: YY=00-99, MM=01-12, DD=01-31.`
          );
        }
      }
    }

    return { errors, warnings };
  }

  /**
   * Helper: Extract YYMMDD column names from schema context
   */
  extractYYMMDDColumns(schemaContext) {
    const columns = [];

    if (typeof schemaContext === 'string') {
      // Parse from string format
      const columnMatches = schemaContext.matchAll(/-\s*(\w+):\s*\w+.*yymmdd/gi);
      for (const match of columnMatches) {
        columns.push(match[1]);
      }

      // Also match columns with yymmdd in name
      const nameMatches = schemaContext.matchAll(/-\s*(\w*yymmdd\w*):/gi);
      for (const match of nameMatches) {
        if (!columns.includes(match[1])) {
          columns.push(match[1]);
        }
      }
    }

    return columns;
  }

  /**
   * Helper: Find nodes by type in EXPLAIN plan
   */
  findNodesByType(plan, nodeType, results = []) {
    if (!plan) return results;

    if (plan['Node Type'] === nodeType) {
      results.push(plan);
    }

    if (plan['Plans']) {
      for (const subPlan of plan['Plans']) {
        this.findNodesByType(subPlan, nodeType, results);
      }
    }

    return results;
  }

  /**
   * Helper: Extract meaningful error message from PostgreSQL error
   */
  extractErrorMessage(error) {
    const message = error.message || String(error);

    // Column not found
    const columnMatch = message.match(/column "([^"]+)" does not exist/i);
    if (columnMatch) {
      return `Column "${columnMatch[1]}" does not exist`;
    }

    // Table not found
    const tableMatch = message.match(/relation "([^"]+)" does not exist/i);
    if (tableMatch) {
      return `Table "${tableMatch[1]}" does not exist`;
    }

    // Syntax error
    const syntaxMatch = message.match(/syntax error at or near "([^"]+)"/i);
    if (syntaxMatch) {
      return `Syntax error near "${syntaxMatch[1]}"`;
    }

    // Ambiguous column
    const ambiguousMatch = message.match(/column reference "([^"]+)" is ambiguous/i);
    if (ambiguousMatch) {
      return `Column "${ambiguousMatch[1]}" is ambiguous. Use table alias.`;
    }

    // GROUP BY error
    if (message.includes('must appear in the GROUP BY clause')) {
      return 'Column in SELECT must be in GROUP BY or use aggregate function';
    }

    return message;
  }

  /**
   * Build feedback string for retry
   */
  buildFeedback(validationResult) {
    const allIssues = [...validationResult.errors, ...validationResult.warnings];

    if (allIssues.length === 0) {
      return '';
    }

    const errorSection =
      validationResult.errors.length > 0
        ? `ERRORS (must fix):\n- ${validationResult.errors.join('\n- ')}`
        : '';

    const warningSection =
      validationResult.warnings.length > 0
        ? `WARNINGS (should fix):\n- ${validationResult.warnings.join('\n- ')}`
        : '';

    return [errorSection, warningSection].filter(Boolean).join('\n\n');
  }
}

export const comprehensiveValidator = new ComprehensiveValidator();
