const TOP_K_PER_GROUP_PATTERN = {
  id: 'top_k_per_group',
  name: 'Top-K per group',
  description:
    'Use ROW_NUMBER() over partition to select the top rows per group (e.g., top per day).',
  snippet: `
-- Top-K per group (example)
WITH ranked AS (
  SELECT
    t.*,
    ROW_NUMBER() OVER (PARTITION BY {group_by} ORDER BY {metric} DESC) AS rn
  FROM {table} t
  WHERE {filters}
)
SELECT *
FROM ranked
WHERE rn <= {top_k}
ORDER BY {group_by}, {metric} DESC
LIMIT {limit};
`.trim(),
  detector: (text) => {
    const hasTopKeyword = /\b(most|top|highest)\b/i.test(text);
    const hasDayGrouping = /\b(daywise|per day|per-day|by day|daily)\b/i.test(text);
    return hasTopKeyword && hasDayGrouping;
  },
};

const DATE_RANGE_PATTERN = {
  id: 'date_range_filter',
  name: 'Date Range Filter (YYMMDD)',
  description:
    'Filter by YYMMDD integer date columns using 6-digit format (e.g., 260114 for 2026-01-14).',
  snippet: `
-- Date range filter for YYMMDD columns
-- IMPORTANT: YYMMDD uses 6 digits, NOT 8 (260114, not 20260114)
SELECT *
FROM {table} t
WHERE t.{date_column}_yymmdd >= {start_yymmdd}
  AND t.{date_column}_yymmdd <= {end_yymmdd}
-- Example: Filter orders from Jan 7-14, 2026
-- WHERE order_date_yymmdd BETWEEN 260107 AND 260114
LIMIT {limit};
`.trim(),
  detector: (text) => {
    const hasDateKeyword =
      /\b(last|past|between|from|since|until|before|after|recent)\b/i.test(text);
    const hasTimeRange = /\b(\d+\s*)?(days?|weeks?|months?|year)\b/i.test(text);
    const hasDateReference =
      /\b(today|yesterday|this week|this month|date)\b/i.test(text);
    return hasDateKeyword && (hasTimeRange || hasDateReference);
  },
};

const AGGREGATION_GROUP_PATTERN = {
  id: 'aggregation_group',
  name: 'Aggregation with Grouping',
  description: 'Aggregate metrics (COUNT, SUM, AVG) grouped by dimensions.',
  snippet: `
-- Aggregation with grouping
SELECT
    {group_column},
    COUNT(*) AS count,
    SUM({metric_column}) AS total,
    AVG({metric_column}) AS average
FROM {table} t
WHERE {filters}
GROUP BY {group_column}
ORDER BY total DESC
LIMIT {limit};
`.trim(),
  detector: (text) => {
    const hasAggregateKeyword =
      /\b(total|sum|count|average|avg|most|least|highest|lowest)\b/i.test(text);
    const hasGroupKeyword =
      /\b(by|per|each|every|group|category|type|wise)\b/i.test(text);
    return hasAggregateKeyword && hasGroupKeyword;
  },
};

const TIME_SERIES_PATTERN = {
  id: 'time_series',
  name: 'Time Series / Daywise Trend',
  description: 'Analyze metrics over time periods with proper date grouping.',
  snippet: `
-- Time series / daywise trend (with YYMMDD date column)
SELECT
    {date_column}_yymmdd AS date,
    COUNT(*) AS count,
    SUM({metric}) AS total
FROM {table} t
WHERE {date_column}_yymmdd BETWEEN {start_yymmdd} AND {end_yymmdd}
GROUP BY {date_column}_yymmdd
ORDER BY date ASC
LIMIT {limit};
`.trim(),
  detector: (text) => {
    const hasTrendKeyword =
      /\b(trend|over time|daily|weekly|monthly|growth|change|history|daywise|day-wise)\b/i.test(
        text
      );
    const hasTimeWord = /\b(day|week|month|year|time|period)\b/i.test(text);
    return hasTrendKeyword || (hasTimeWord && /\b(by|per|each)\b/i.test(text));
  },
};

export class PatternLibrary {
  constructor() {
    this.patterns = [
      TOP_K_PER_GROUP_PATTERN,
      DATE_RANGE_PATTERN,
      AGGREGATION_GROUP_PATTERN,
      TIME_SERIES_PATTERN,
    ];
  }

  detectPatterns({ question, instruction }) {
    const combined = `${question || ''} ${instruction || ''}`.trim();
    if (!combined) {
      return [];
    }

    return this.patterns.filter((pattern) => pattern.detector(combined));
  }

  buildSnippetBlock(patterns) {
    if (!patterns.length) {
      return 'None';
    }

    return patterns
      .map(
        (pattern) =>
          `${pattern.name}:\n${pattern.snippet}\nDescription: ${pattern.description}`
      )
      .join('\n\n');
  }

  hasTopKPerGroup(patterns) {
    return patterns.some((pattern) => pattern.id === TOP_K_PER_GROUP_PATTERN.id);
  }
}
