# NL to SQL Backend

Production-ready Node.js backend for Natural Language to SQL conversion.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your configuration
# Start development server
npm run dev

# Start production server
npm start
```

## API Endpoints

### Health Check
```
GET /health
```

### Authentication
```
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET /api/v1/auth/me
```

### Database Management
```
GET /api/v1/databases
GET /api/v1/databases/:databaseName/tables
GET /api/v1/databases/:databaseName/tables/:tableName/schema
GET /api/v1/databases/:databaseName/tables/:tableName/data
POST /api/v1/databases/:databaseName/index
```

### Query Execution
```
POST /api/v1/query/execute
GET /api/v1/query/history
```

## Architecture

- **Express.js**: Web framework
- **PostgreSQL + PGVector**: Database with vector search
- **LangChain**: AI orchestration
- **OpenAI (via LangChain)**: Natural language understanding
- **JWT**: Authentication
- **Winston**: Logging

## Key Features

- Vector embeddings for schema matching
- SQL injection prevention
- Rate limiting
- Comprehensive error handling
- Request validation
- Query history tracking

## Embedding Maintenance

If you change `EMBEDDING_MODEL` or `EMBEDDING_DIMENSION`, run:

```bash
node scripts/migrate_embedding_dimension.js
node scripts/regenerate_embeddings.js
```

## Environment Variables

- `LLM_API_KEY`: API key for the LLM provider (OpenAI by default)
- `LLM_PROVIDER`: `openai` or `google` (default `openai`)
- `LLM_BASE_URL`: Optional OpenAI-compatible base URL (for hosted providers)
- `LLM_LOG_FULL_KEY`: `true` to log full LLM API key at startup (default `false`, use with caution)
- `LLM_MODEL`: Chat model name (default `gpt-4o-mini`)
- `LLM_TEMPERATURE`: Sampling temperature (default `0`)
- `EMBEDDING_MODEL`: Embedding model name (default `text-embedding-3-small`)
- `EMBEDDING_DIMENSION`: Embedding vector dimension (default `1536`)
