export class SqlSemanticValidator {
  validate(sql, intent, schema = []) {
    const issues = [];
    const normalized = sql.toLowerCase();

    // Existing: Top-K per group validation
    if (intent?.top_k_per_group && intent.top_k_per_group >= 1) {
      const hasRowNumber = /row_number\s*\(/i.test(normalized);
      const hasDistinctOn = /\bdistinct\s+on\s*\(/i.test(normalized);
      if (!hasRowNumber && !hasDistinctOn) {
        issues.push(
          'Missing top-k per group logic. Use ROW_NUMBER() OVER (PARTITION BY ...) or DISTINCT ON.'
        );
      }
    }

    // New: GroupBy consistency validation
    issues.push(...this.validateGroupByConsistency(sql, intent));

    // New: YYMMDD date format validation
    issues.push(...this.validateYYMMDDFormat(sql, schema));

    return {
      isValid: issues.length === 0,
      issues,
    };
  }

  validateGroupByConsistency(sql, intent) {
    const issues = [];
    const normalized = sql.toLowerCase();

    // Check if intent specifies group_by fields
    if (intent?.group_by?.length > 0) {
      const groupByMatch = normalized.match(
        /group\s+by\s+([^order|having|limit|;]+)/i
      );

      if (!groupByMatch) {
        // Check if using window function with PARTITION BY instead
        const hasPartitionBy = /partition\s+by/i.test(normalized);
        if (!hasPartitionBy) {
          issues.push(
            `Intent requires grouping by [${intent.group_by.join(', ')}] but no GROUP BY or PARTITION BY clause found.`
          );
        }
      } else {
        const groupByClause = groupByMatch[1].toLowerCase();
        for (const field of intent.group_by) {
          const fieldLower = field.toLowerCase();
          // Check for field name (with or without table alias)
          const fieldPattern = new RegExp(`\\b${fieldLower}\\b`, 'i');
          if (!fieldPattern.test(groupByClause)) {
            issues.push(
              `Field "${field}" specified in intent but not found in GROUP BY clause.`
            );
          }
        }
      }
    }

    // Check for aggregates without GROUP BY when selecting non-aggregated columns
    const aggregates = ['count(', 'sum(', 'avg(', 'max(', 'min('];
    const hasAggregate = aggregates.some((agg) => normalized.includes(agg));
    const hasGroupBy = /\bgroup\s+by\b/i.test(normalized);
    const hasPartitionBy = /\bpartition\s+by\b/i.test(normalized);

    if (hasAggregate && !hasGroupBy && !hasPartitionBy) {
      // Extract SELECT clause to check for non-aggregated columns
      const selectMatch = normalized.match(/select\s+(.*?)\s+from/is);
      if (selectMatch) {
        const selectClause = selectMatch[1];
        const columns = selectClause.split(',');
        const nonAggregatedCols = columns.filter((col) => {
          const trimmed = col.trim();
          const isAggregated = aggregates.some((agg) => trimmed.includes(agg));
          const isLiteral = /^\d+$|^'.*'$/.test(trimmed);
          const isStar = trimmed === '*';
          return !isAggregated && !isLiteral && !isStar && trimmed.length > 0;
        });

        if (nonAggregatedCols.length > 0) {
          issues.push(
            `Query has aggregates but no GROUP BY. Non-aggregated columns may cause errors or unexpected results.`
          );
        }
      }
    }

    return issues;
  }

  validateYYMMDDFormat(sql, schema) {
    const issues = [];

    // Extract YYMMDD column names from schema
    const yymmddColumns = this.extractYYMMDDColumns(schema);

    // Check for 8-digit YYYYMMDD format (common mistake)
    // Pattern: 19XXXXXX or 20XXXXXX (years 1900-2099)
    const eightDigitPattern = /\b(19|20)\d{6}\b/g;
    const matches = sql.match(eightDigitPattern);
    if (matches) {
      const uniqueMatches = [...new Set(matches)];
      issues.push(
        `Detected YYYYMMDD format values [${uniqueMatches.join(', ')}]. YYMMDD columns use 6-digit format (e.g., 260114 for 2026-01-14, not 20260114).`
      );
    }

    // Check for date string comparisons on YYMMDD columns
    for (const colName of yymmddColumns) {
      const dateStringPattern = new RegExp(
        `${colName}\\s*[=<>!]+\\s*'\\d{4}-\\d{2}-\\d{2}'`,
        'i'
      );
      if (dateStringPattern.test(sql)) {
        issues.push(
          `Column "${colName}" is YYMMDD integer but compared with date string. Use integer comparison (e.g., 260114).`
        );
      }
    }

    return issues;
  }

  extractYYMMDDColumns(schema) {
    const yymmddColumns = [];

    if (!Array.isArray(schema)) {
      return yymmddColumns;
    }

    for (const table of schema) {
      const schemaInfo = table.schemaInfo || table.columns || [];
      for (const col of schemaInfo) {
        const colName = col.column_name || col.name || '';
        const colDesc = col.column_description || col.description || '';

        // Detect YYMMDD columns by name pattern or description
        if (
          colName.toLowerCase().includes('yymmdd') ||
          colDesc.toLowerCase().includes('yymmdd')
        ) {
          yymmddColumns.push(colName);
        }
      }
    }

    return yymmddColumns;
  }
}
