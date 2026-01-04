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
- **OpenAI GPT-4**: Natural language understanding
- **JWT**: Authentication
- **Winston**: Logging

## Key Features

- Vector embeddings for schema matching
- SQL injection prevention
- Rate limiting
- Comprehensive error handling
- Request validation
- Query history tracking
