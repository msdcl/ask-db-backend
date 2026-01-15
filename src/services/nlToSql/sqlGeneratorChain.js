import { PromptTemplate } from '@langchain/core/prompts';
import { ValidationError } from '../../utils/errors.js';

export class SqlGeneratorChain {
  constructor(llmClient) {
    this.llmClient = llmClient;
    this.promptTemplate = PromptTemplate.fromTemplate(`
You are an expert PostgreSQL query generator. Convert the following request into SQL.

Database Schema:
{schema}

Intent JSON:
{intentJson}

Pattern Snippets:
{patternSnippets}

CRITICAL DATE HANDLING (YYMMDD format):
- Columns with "yymmdd" in their name store dates as 6-DIGIT integers
- Format: YYMMDD where YY=year(00-99), MM=month(01-12), DD=day(01-31)
- Example: January 14, 2026 = 260114 (NOT 20260114)
- NEVER use 8-digit YYYYMMDD format - it will fail validation
- NEVER compare with date strings like '2026-01-14'
- For date math: today(260115) minus 7 days = 260108

Date Examples:
- 260101 = Jan 1, 2026
- 260115 = Jan 15, 2026
- 251231 = Dec 31, 2025

Important Rules:
1. Generate ONLY the SQL query without any explanation
2. Use proper PostgreSQL syntax
3. Include appropriate WHERE clauses, JOINs, GROUP BY, ORDER BY as needed
4. For "daywise" or "per day" queries, GROUP BY the date column
5. For "most/top per day" queries, use ROW_NUMBER() OVER (PARTITION BY date_column)
6. Always use table aliases for clarity
7. Return only SELECT queries for safety
8. Do not include any markdown formatting or code blocks
9. Always include a LIMIT clause (use LIMIT 100 if unsure)

User Question: {question}
Additional Instructions: {instruction}

Corrective Feedback (if any):
{feedback}

SQL Query:`);
  }

  async generate({
    question,
    instruction,
    schema,
    intent,
    patternSnippets,
    feedback = '',
  }) {
    const prompt = await this.promptTemplate.format({
      schema,
      intentJson: JSON.stringify(intent, null, 2),
      patternSnippets,
      question,
      instruction: instruction?.trim() || '',
      feedback,
    });

    let sqlQuery = await this.llmClient.generateText(prompt);
    sqlQuery = this.sanitizeSQL(sqlQuery);
    sqlQuery = this.ensureLimit(sqlQuery);
    this.validateSQL(sqlQuery);

    return sqlQuery;
  }

  sanitizeSQL(sql) {
    let cleaned = sql.replace(/```sql\n?/gi, '').replace(/```\n?/g, '');
    cleaned = cleaned.trim();
    if (cleaned.endsWith(';')) {
      cleaned = cleaned.slice(0, -1);
    }
    return cleaned;
  }

  stripSQLComments(sql) {
    let stripped = sql.replace(/--[^\n]*/g, '');
    stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, '');
    return stripped;
  }

  ensureLimit(sql) {
    const stripped = this.stripSQLComments(sql);
    if (/\blimit\b/i.test(stripped)) {
      return sql;
    }
    return `${sql} LIMIT 100`;
  }

  validateSQL(sql) {
    const strippedSQL = this.stripSQLComments(sql);
    const normalizedSQL = strippedSQL.toLowerCase().replace(/\s+/g, ' ').trim();

    if (sql.includes(';')) {
      throw new ValidationError('Multiple SQL statements are not allowed');
    }

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
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(normalizedSQL)) {
        throw new ValidationError(
          `Query contains forbidden operation: ${keyword.toUpperCase()}`
        );
      }
    }

    if (!normalizedSQL.startsWith('select ') && normalizedSQL !== 'select') {
      throw new ValidationError('Only SELECT queries are allowed');
    }

    const unionPattern = /\bunion\b.*\b(insert|update|delete|drop|alter|create)\b/i;
    if (unionPattern.test(normalizedSQL)) {
      throw new ValidationError('Invalid UNION query detected');
    }
  }
}
