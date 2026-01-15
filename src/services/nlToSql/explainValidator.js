import { logger } from '../../utils/logger.js';

export class ExplainValidator {
  constructor(databaseService) {
    this.databaseService = databaseService;
  }

  async validate(sql, databaseConfigId, organizationId) {
    const issues = [];

    try {
      // Use EXPLAIN (not ANALYZE) - parses and plans but doesn't execute
      const explainSql = `EXPLAIN (FORMAT JSON) ${sql}`;
      const result = await this.databaseService.executeQuery(
        databaseConfigId,
        organizationId,
        explainSql
      );

      const plan = result.data[0]['QUERY PLAN'][0]['Plan'];

      // Check for sequential scans on potentially large tables
      const seqScans = this.findNodesByType(plan, 'Seq Scan');
      for (const scan of seqScans) {
        if (scan['Plan Rows'] > 10000) {
          issues.push({
            severity: 'warning',
            message: `Sequential scan on "${scan['Relation Name']}" may be slow (estimated ${scan['Plan Rows']} rows).`,
          });
        }
      }

      // Check for nested loops without join conditions (potential Cartesian product)
      const nestedLoops = this.findNodesByType(plan, 'Nested Loop');
      for (const loop of nestedLoops) {
        if (!loop['Join Filter'] && !loop['Index Cond']) {
          issues.push({
            severity: 'warning',
            message:
              'Nested loop join without filter detected. May indicate missing join condition.',
          });
        }
      }

      // Check for very large estimated result sets
      if (plan['Plan Rows'] > 1000000) {
        issues.push({
          severity: 'warning',
          message: `Query may return very large result set (estimated ${plan['Plan Rows']} rows).`,
        });
      }

      // Log warnings but don't fail validation for them
      if (issues.length > 0) {
        logger.warn('SQL validation warnings', { sql, issues });
      }

      return { isValid: true, issues, plan };
    } catch (error) {
      // EXPLAIN failed - likely syntax error or invalid column/table reference
      logger.error('EXPLAIN validation failed', { sql, error: error.message });

      return {
        isValid: false,
        issues: [
          {
            severity: 'error',
            message: `Query validation failed: ${this.extractErrorMessage(error)}`,
          },
        ],
        plan: null,
      };
    }
  }

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

  extractErrorMessage(error) {
    const message = error.message || String(error);

    // Extract meaningful part from PostgreSQL errors
    const columnMatch = message.match(/column "([^"]+)" does not exist/i);
    if (columnMatch) {
      return `Column "${columnMatch[1]}" does not exist`;
    }

    const tableMatch = message.match(/relation "([^"]+)" does not exist/i);
    if (tableMatch) {
      return `Table "${tableMatch[1]}" does not exist`;
    }

    const syntaxMatch = message.match(/syntax error at or near "([^"]+)"/i);
    if (syntaxMatch) {
      return `Syntax error near "${syntaxMatch[1]}"`;
    }

    return message;
  }
}
