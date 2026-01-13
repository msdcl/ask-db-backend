import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

class LLMClient {
  constructor() {
    this.logConfig();
    this.chatModel = this.createChatModel();
    this.embeddingModel = this.createEmbeddingModel();
  }

  logConfig() {
    const key = config.llm.apiKey || '';
    console.log("key----> ", key);
    const maskedKey = key.length > 8
      ? `${key.slice(0, 4)}...${key.slice(-4)}`
      : '***';
    const apiKeyToLog = config.llm.logFullKey ? key : maskedKey;
    logger.info('LLM client config', {
      provider: config.llm.provider,
      model: config.llm.model,
      embeddingModel: config.embedding.model,
      apiKey: apiKeyToLog,
    });
  }

  createChatModel() {
    if (config.llm.provider === 'google') {
      return new ChatGoogleGenerativeAI({
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        temperature: config.llm.temperature,
      });
    }

    return new ChatOpenAI({
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      temperature: config.llm.temperature,
      configuration: config.llm.baseUrl ? { baseURL: config.llm.baseUrl } : undefined,
    });
  }

  createEmbeddingModel() {
    if (config.llm.provider === 'google') {
      return new GoogleGenerativeAIEmbeddings({
        apiKey: config.llm.apiKey,
        model: config.embedding.model,
      });
    }

    return new OpenAIEmbeddings({
      apiKey: config.llm.apiKey,
      model: config.embedding.model,
      configuration: config.llm.baseUrl ? { baseURL: config.llm.baseUrl } : undefined,
    });
  }

  async generateText(prompt) {
    const response = await this.chatModel.invoke(prompt);
    return String(response.content || '').trim();
  }

  async generateEmbedding(text) {
    return this.embeddingModel.embedQuery(text);
  }
}

export const llmClient = new LLMClient();
