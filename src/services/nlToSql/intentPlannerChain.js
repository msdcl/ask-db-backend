import { PromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { ValidationError } from '../../utils/errors.js';

const sortSchema = z.object({
  field: z.string().min(1),
  order: z.enum(['asc', 'desc']),
});

const intentSchema = z
  .object({
    metric: z.string().min(1),
    entity: z.string().min(1),
    group_by: z.array(z.string().min(1)).default([]),
    filters: z
      .record(
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.string()),
          z.array(z.number()),
        ])
      )
      .default({}),
    top_k_per_group: z.number().int().min(1).optional(),
    sort: z.array(sortSchema).default([]),
  })
  .strict();

const extractJsonObject = (text) => {
  const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return cleaned.slice(start, end + 1);
};

export class IntentPlannerChain {
  constructor(llmClient) {
    this.llmClient = llmClient;
    this.promptTemplate = PromptTemplate.fromTemplate(`
You are a strict JSON planner for SQL analytics. Convert the user request into JSON only.

Rules:
1. Output ONLY valid JSON (no markdown, no commentary)
2. Use the exact keys shown below
3. Prefer snake_case field names
4. If a field is unknown, omit it or use empty array/object

JSON Shape:
{{
  "metric": "count(order_items)",
  "entity": "product",
  "group_by": ["order_day"],
  "filters": {{"last_days": 20}},
  "top_k_per_group": 1,
  "sort": [{{"field": "metric", "order": "desc"}}]
}}

Schema Context:
{schema}

Pattern Hints:
{patternHints}

User Question: {question}
Additional Instructions: {instruction}

JSON:`);
  }

  async plan({ question, instruction, schema, patternHints }) {
    const prompt = await this.promptTemplate.format({
      question,
      instruction: instruction?.trim() || '',
      schema,
      patternHints,
    });

    const raw = await this.llmClient.generateText(prompt);
    const jsonText = extractJsonObject(raw);
    if (!jsonText) {
      throw new ValidationError('Intent planner returned invalid JSON');
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      throw new ValidationError('Intent planner returned malformed JSON');
    }

    try {
      return intentSchema.parse(parsed);
    } catch (error) {
      throw new ValidationError('Intent JSON failed validation');
    }
  }
}
