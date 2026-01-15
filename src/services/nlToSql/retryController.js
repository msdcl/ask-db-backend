import { ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export class RetryController {
  constructor(sqlGenerator, semanticValidator, explainValidator = null, maxRetries = 2) {
    this.sqlGenerator = sqlGenerator;
    this.semanticValidator = semanticValidator;
    this.explainValidator = explainValidator;
    this.maxRetries = maxRetries;
  }

  async generateWithRetry(params, dbContext = null) {
    let attempt = 0;
    let feedback = '';
    let sql = '';

    while (attempt <= this.maxRetries) {
      sql = await this.sqlGenerator.generate({ ...params, feedback });

      // Step 1: Semantic validation (fast, no DB call)
      const semanticValidation = this.semanticValidator.validate(
        sql,
        params.intent,
        params.schemaObjects || []
      );

      if (!semanticValidation.isValid) {
        feedback = this.buildFeedback(semanticValidation.issues, 'semantic');
        attempt += 1;
        continue;
      }

      // Step 2: EXPLAIN validation (optional, requires DB call)
      if (this.explainValidator && dbContext) {
        const explainValidation = await this.explainValidator.validate(
          sql,
          dbContext.databaseConfigId,
          dbContext.organizationId
        );

        if (!explainValidation.isValid) {
          feedback = this.buildFeedback(
            explainValidation.issues.map((i) => i.message),
            'syntax'
          );
          attempt += 1;
          continue;
        }

        // Log warnings but don't fail
        const warnings = explainValidation.issues.filter(
          (i) => i.severity === 'warning'
        );
        if (warnings.length > 0) {
          logger.warn('SQL generated with warnings', {
            sql,
            warnings: warnings.map((w) => w.message),
          });
        }
      }

      return sql;
    }

    throw new ValidationError('SQL failed validation after retries');
  }

  buildFeedback(issues, type) {
    const prefix =
      type === 'semantic'
        ? 'The SQL failed semantic validation'
        : 'The SQL has syntax or reference errors';
    return `${prefix}:\n- ${issues.join('\n- ')}\nPlease fix these issues and regenerate the SQL.`;
  }
}
