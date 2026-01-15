import {
  ECOMMERCE_GLOSSARY,
  INTENT_TYPES,
  ENTITY_PATTERNS,
  TIME_PATTERNS,
} from '../../config/ecommerceGlossary.js';
import { logger } from '../../utils/logger.js';

export class QueryAnalyzer {
  constructor(llmClient = null) {
    this.llmClient = llmClient;
    this.glossary = ECOMMERCE_GLOSSARY;
    this.intentTypes = INTENT_TYPES;
  }

  /**
   * Analyze a natural language query
   * Returns structured analysis for better SQL generation
   */
  async analyze(query, instruction = '') {
    const combined = `${query} ${instruction}`.trim();

    // 1. Extract entities
    const entities = this.extractEntities(combined);

    // 2. Classify intent(s)
    const intents = this.classifyIntents(combined);

    // 3. Extract time range
    const timeRange = this.extractTimeRange(combined);
    const timeRangeYYMMDD = this.timeRangeToYYMMDD(timeRange);

    // 4. Resolve glossary terms
    const resolvedTerms = this.resolveGlossaryTerms(combined);

    // 5. Identify metrics
    const metrics = this.identifyMetrics(combined, resolvedTerms);

    // 6. Extract grouping hints
    const grouping = this.extractGrouping(combined);

    // 7. Extract limit/top-N
    const limit = this.extractLimit(combined);

    // 8. Build enriched query for embedding
    const enrichedQuery = this.buildEnrichedQuery(
      query,
      entities,
      resolvedTerms,
      metrics
    );

    return {
      originalQuery: query,
      instruction,
      entities,
      intents,
      primaryIntent: intents[0] || null,
      timeRange,
      timeRangeYYMMDD,
      resolvedTerms,
      metrics,
      grouping,
      limit,
      enrichedQuery,
      analysisMetadata: {
        hasAggregation: intents.some((i) => i.requiresAggregate),
        hasRanking: intents.some((i) => i.requiresOrderBy),
        hasTimeFilter: !!timeRange,
        hasGrouping: grouping.length > 0,
      },
    };
  }

  /**
   * Extract entities from query (products, customers, orders, etc.)
   */
  extractEntities(query) {
    const entities = [];
    const lowerQuery = query.toLowerCase();

    for (const [entityType, pattern] of Object.entries(ENTITY_PATTERNS)) {
      if (pattern.test(lowerQuery)) {
        entities.push({
          type: entityType,
          confidence: 0.9,
        });
      }
    }

    // Also check glossary entity mappings
    for (const [term, config] of Object.entries(this.glossary)) {
      if (config.mapsTo && !config.calculation) {
        const termPattern = new RegExp(`\\b${term}\\b`, 'i');
        const altPatterns = (config.alternateNames || []).map(
          (n) => new RegExp(`\\b${n}\\b`, 'i')
        );

        if (termPattern.test(lowerQuery) || altPatterns.some((p) => p.test(lowerQuery))) {
          const tableName = config.mapsTo.split('.')[0];
          if (!entities.find((e) => e.type === tableName)) {
            entities.push({
              type: tableName,
              confidence: 0.85,
              fromGlossary: true,
            });
          }
        }
      }
    }

    return entities;
  }

  /**
   * Classify query intents
   */
  classifyIntents(query) {
    const intents = [];
    const lowerQuery = query.toLowerCase();

    for (const [intentKey, config] of Object.entries(this.intentTypes)) {
      const keywordMatch = config.keywords.some((kw) => lowerQuery.includes(kw));
      if (keywordMatch) {
        intents.push({
          type: intentKey,
          name: config.name,
          confidence: 0.8,
          ...config,
        });
      }
    }

    // Sort by specificity (more specific intents first)
    intents.sort((a, b) => {
      const specificityA = (a.requiresAggregate ? 1 : 0) + (a.requiresOrderBy ? 1 : 0);
      const specificityB = (b.requiresAggregate ? 1 : 0) + (b.requiresOrderBy ? 1 : 0);
      return specificityB - specificityA;
    });

    // Default to LIST if no intent detected
    if (intents.length === 0) {
      intents.push({
        type: 'LIST',
        name: 'List',
        confidence: 0.5,
        isListing: true,
      });
    }

    return intents;
  }

  /**
   * Extract time range from query
   */
  extractTimeRange(query) {
    const lowerQuery = query.toLowerCase();

    // Check each time pattern
    for (const [patternName, pattern] of Object.entries(TIME_PATTERNS)) {
      const match = lowerQuery.match(pattern);
      if (match) {
        return this.parseTimePattern(patternName, match);
      }
    }

    return null;
  }

  parseTimePattern(patternName, match) {
    const now = new Date();

    switch (patternName) {
      case 'lastNDays': {
        const days = parseInt(match[1], 10);
        const start = new Date(now);
        start.setDate(start.getDate() - days);
        return { type: 'relative', period: 'days', value: days, start, end: now };
      }
      case 'lastNWeeks': {
        const weeks = parseInt(match[1], 10);
        const start = new Date(now);
        start.setDate(start.getDate() - weeks * 7);
        return { type: 'relative', period: 'weeks', value: weeks, start, end: now };
      }
      case 'lastNMonths': {
        const months = parseInt(match[1], 10);
        const start = new Date(now);
        start.setMonth(start.getMonth() - months);
        return { type: 'relative', period: 'months', value: months, start, end: now };
      }
      case 'thisWeek': {
        const start = new Date(now);
        start.setDate(start.getDate() - start.getDay());
        return { type: 'current', period: 'week', start, end: now };
      }
      case 'thisMonth': {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        return { type: 'current', period: 'month', start, end: now };
      }
      case 'thisYear': {
        const start = new Date(now.getFullYear(), 0, 1);
        return { type: 'current', period: 'year', start, end: now };
      }
      case 'lastWeek': {
        const end = new Date(now);
        end.setDate(end.getDate() - end.getDay());
        const start = new Date(end);
        start.setDate(start.getDate() - 7);
        return { type: 'previous', period: 'week', start, end };
      }
      case 'lastMonth': {
        const end = new Date(now.getFullYear(), now.getMonth(), 0);
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        return { type: 'previous', period: 'month', start, end };
      }
      case 'yesterday': {
        const date = new Date(now);
        date.setDate(date.getDate() - 1);
        return { type: 'specific', period: 'day', start: date, end: date };
      }
      case 'today': {
        return { type: 'specific', period: 'day', start: now, end: now };
      }
      default:
        return { type: 'unknown', raw: match[0] };
    }
  }

  /**
   * Resolve glossary terms in query
   */
  resolveGlossaryTerms(query) {
    const resolved = [];
    const lowerQuery = query.toLowerCase();

    for (const [term, config] of Object.entries(this.glossary)) {
      const termPattern = new RegExp(`\\b${term}\\b`, 'i');
      const altPatterns = (config.alternateNames || []).map(
        (n) => new RegExp(`\\b${n.replace(/\s+/g, '\\s+')}\\b`, 'i')
      );

      const matched =
        termPattern.test(lowerQuery) || altPatterns.some((p) => p.test(lowerQuery));

      if (matched) {
        resolved.push({
          term,
          ...config,
        });
      }
    }

    return resolved;
  }

  /**
   * Identify metrics mentioned in query
   */
  identifyMetrics(query, resolvedTerms) {
    const metrics = [];
    const lowerQuery = query.toLowerCase();

    // From resolved glossary terms
    for (const term of resolvedTerms) {
      if (term.calculation) {
        metrics.push({
          name: term.name,
          calculation: term.calculation,
          tables: term.tables,
          fromGlossary: true,
        });
      }
    }

    // Common metric patterns
    const metricPatterns = [
      { pattern: /sales|revenue/i, metric: 'revenue', aggregate: 'SUM' },
      { pattern: /count|number of|how many/i, metric: 'count', aggregate: 'COUNT' },
      { pattern: /average|avg|mean/i, metric: 'average', aggregate: 'AVG' },
      { pattern: /total|sum/i, metric: 'total', aggregate: 'SUM' },
      { pattern: /maximum|max|highest/i, metric: 'max', aggregate: 'MAX' },
      { pattern: /minimum|min|lowest/i, metric: 'min', aggregate: 'MIN' },
    ];

    for (const { pattern, metric, aggregate } of metricPatterns) {
      if (pattern.test(lowerQuery) && !metrics.find((m) => m.name === metric)) {
        metrics.push({
          name: metric,
          aggregate,
          fromPattern: true,
        });
      }
    }

    return metrics;
  }

  /**
   * Extract grouping hints from query
   */
  extractGrouping(query) {
    const grouping = [];
    const lowerQuery = query.toLowerCase();

    // Patterns like "by category", "per day", "for each customer"
    const groupPatterns = [
      { pattern: /by\s+(\w+)/gi, type: 'by' },
      { pattern: /per\s+(\w+)/gi, type: 'per' },
      { pattern: /for each\s+(\w+)/gi, type: 'each' },
      { pattern: /(\w+)[-\s]?wise/gi, type: 'wise' },
      { pattern: /group(?:ed)?\s+by\s+(\w+)/gi, type: 'group' },
    ];

    for (const { pattern, type } of groupPatterns) {
      let match;
      while ((match = pattern.exec(lowerQuery)) !== null) {
        const dimension = match[1].toLowerCase();

        // Skip common false positives
        if (['the', 'a', 'an', 'to', 'in', 'on'].includes(dimension)) {
          continue;
        }

        if (!grouping.find((g) => g.dimension === dimension)) {
          grouping.push({
            dimension,
            type,
            isTimeDimension: ['day', 'week', 'month', 'year', 'date', 'time'].includes(
              dimension
            ),
          });
        }
      }
    }

    return grouping;
  }

  /**
   * Extract limit/top-N from query
   */
  extractLimit(query) {
    const lowerQuery = query.toLowerCase();

    // Patterns like "top 10", "first 5", "limit 100"
    const limitPatterns = [
      /top\s+(\d+)/i,
      /first\s+(\d+)/i,
      /limit\s+(\d+)/i,
      /(\d+)\s+(?:best|worst|most|least)/i,
    ];

    for (const pattern of limitPatterns) {
      const match = lowerQuery.match(pattern);
      if (match) {
        return parseInt(match[1], 10);
      }
    }

    // Word numbers
    const wordNumbers = {
      one: 1, two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      twenty: 20, fifty: 50, hundred: 100,
    };

    for (const [word, num] of Object.entries(wordNumbers)) {
      const wordPattern = new RegExp(`top\\s+${word}\\b`, 'i');
      if (wordPattern.test(lowerQuery)) {
        return num;
      }
    }

    return null;
  }

  /**
   * Build enriched query for better embedding/retrieval
   */
  buildEnrichedQuery(query, entities, resolvedTerms, metrics) {
    let enriched = query;

    // Add entity expansions
    for (const entity of entities) {
      if (entity.fromGlossary) {
        // Already expanded
        continue;
      }
      // Could expand abbreviations here
    }

    // Add metric context
    for (const term of resolvedTerms) {
      if (term.calculation && !enriched.toLowerCase().includes(term.name.toLowerCase())) {
        enriched += ` (${term.name})`;
      }
    }

    return enriched;
  }

  /**
   * Convert time range to YYMMDD format for queries
   */
  timeRangeToYYMMDD(timeRange) {
    if (!timeRange || !timeRange.start) {
      return null;
    }

    const formatYYMMDD = (date) => {
      const yy = date.getFullYear() % 100;
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      return parseInt(`${yy}${mm}${dd}`, 10);
    };

    return {
      start: formatYYMMDD(timeRange.start),
      end: formatYYMMDD(timeRange.end || timeRange.start),
    };
  }
}

export const queryAnalyzer = new QueryAnalyzer();
