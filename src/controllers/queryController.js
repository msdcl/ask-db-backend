import { nlToSqlService } from '../services/nlToSqlService.js';
import { database } from '../config/database.js';
import { logger } from '../utils/logger.js';

export const executeNaturalQuery = async (req, res, next) => {
  const startTime = Date.now();
  let sqlQuery = '';
  let executionStatus = 'success';
  let errorMessage = null;

  try {
    const { query, databaseConfigId, instruction } = req.body;
    const userId = req.user.id;
    const organizationId = req.user.organizationId;
    const trimmedInstruction = instruction?.trim() || '';

    logger.info('Processing natural language query', {
      userId,
      query,
      instruction: trimmedInstruction || null,
      databaseConfigId,
    });

    const { sql, result, rowCount, relevantTables } = await nlToSqlService.askQuestion(
      query,
      databaseConfigId,
      organizationId,
      trimmedInstruction
    );

    sqlQuery = sql;

    const visualizationType = await nlToSqlService.analyzeQueryIntent(
      query,
      trimmedInstruction
    );

    const executionTime = Date.now() - startTime;

    await database.query(
      `INSERT INTO query_history
       (user_id, database_config_id, natural_query, generated_sql, execution_status, execution_time_ms, result_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, databaseConfigId, query, sql, executionStatus, executionTime, rowCount]
    );

    res.status(200).json({
      success: true,
      data: {
        query,
        sql,
        result,
        rowCount,
        executionTime,
        visualizationType,
        relevantTables,
      },
    });
  } catch (error) {
    executionStatus = 'error';
    errorMessage = error.message;
    if (!sqlQuery && error.generatedSql) {
      sqlQuery = error.generatedSql;
    }

    if (sqlQuery) {
      error.generatedSql = sqlQuery;
    }

    if (sqlQuery && req.user) {
      await database.query(
        `INSERT INTO query_history
         (user_id, database_config_id, natural_query, generated_sql, execution_status, error_message, execution_time_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.user.id,
          req.body.databaseConfigId,
          req.body.query,
          sqlQuery,
          executionStatus,
          errorMessage,
          Date.now() - startTime,
        ]
      ).catch((dbError) => {
        logger.error('Failed to log query history:', dbError);
      });
    }

    next(error);
  }
};

export const getQueryHistory = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { limit = 20, offset = 0 } = req.query;

    const result = await database.query(
      `SELECT
         qh.id,
         qh.database_config_id,
         qh.natural_query,
         qh.generated_sql,
         dc.database_name,
         qh.execution_status,
         qh.error_message,
         qh.execution_time_ms,
         qh.result_count,
         qh.created_at
       FROM query_history qh
       JOIN database_configurations dc ON qh.database_config_id = dc.id
       WHERE qh.user_id = $1
       ORDER BY qh.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    const countResult = await database.query(
      'SELECT COUNT(*) as total FROM query_history WHERE user_id = $1',
      [userId]
    );

    res.status(200).json({
      success: true,
      data: {
        history: result.rows,
        total: parseInt(countResult.rows[0].total),
      },
    });
  } catch (error) {
    next(error);
  }
};
