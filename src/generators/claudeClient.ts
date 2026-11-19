import { getProvider, JsonSchema, QuotaExhaustedError } from './llmProvider';

// Re-exported so existing imports from this module keep working.
export { JsonSchema, QuotaExhaustedError };

/** The configured provider (LLM_PROVIDER in .env). */
const provider = getProvider();

/** Model used for all LLM calls, as reported by the configured provider. */
export const MODEL = provider.model;

/** Options for callClaudeJson(). */
export interface ClaudeJsonRequest {
  /** System prompt. */
  system: string;
  /** User prompt. */
  prompt: string;
  /** JSON schema the reply must match. */
  schema: JsonSchema;
  /** Output token cap (default 64000). */
  maxTokens?: number;
}

/**
 * Sends a prompt to the configured LLM provider and returns its reply parsed
 * as JSON.
 *
 * The name is kept from the original Claude client so callers do not change.
 * The provider is chosen by LLM_PROVIDER in .env ('anthropic' or 'gemini').
 * A 429 throws QuotaExhaustedError.
 *
 * @param request - System prompt, user prompt and JSON schema.
 * @returns The parsed reply.
 * @throws On API errors, a refusal, truncated output, or unparseable JSON.
 */
export async function callClaudeJson<T>(request: ClaudeJsonRequest): Promise<T> {
  const started = Date.now();
  console.log(`  [llm] -> calling ${MODEL} (prompt ${request.prompt.length} chars)`);
  try {
    const text = await provider.call(request.system, request.prompt, request.maxTokens ?? 64000, request.schema);
    console.log(`  [llm] <- response in ${Date.now() - started}ms`);
    return JSON.parse(text) as T;
  } catch (error) {
    console.error(`  [llm] x call failed after ${Date.now() - started}ms`);
    if (error instanceof QuotaExhaustedError) throw error;
    throw new Error(`LLM request failed: ${(error as Error).message}`);
  }
}
