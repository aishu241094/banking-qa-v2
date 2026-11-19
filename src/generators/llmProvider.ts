import * as dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { ApiError, FinishReason, GenerateContentResponse, GoogleGenAI } from '@google/genai';

dotenv.config();

/** A JSON schema object passed to structured outputs. */
export type JsonSchema = Record<string, unknown>;

/** Supported values for LLM_PROVIDER in .env. */
export type ProviderName = 'anthropic' | 'gemini';

/**
 * Thrown on a 429 (rate limit, exhausted quota or exhausted credit) from any
 * provider. Not retried: callers should stop making calls instead of
 * spending more.
 */
export class QuotaExhaustedError extends Error {
  constructor(detail: string) {
    super(`LLM rate limit or quota hit - check your usage and billing, then run again (${detail})`);
    this.name = 'QuotaExhaustedError';
  }
}

/** A model-agnostic text-generation backend. */
export interface LLMProvider {
  /** Model this provider calls, for logging. */
  readonly model: string;

  /**
   * Sends one prompt and returns the model's raw text reply.
   *
   * @param system - System prompt.
   * @param prompt - User prompt.
   * @param maxTokens - Output token cap.
   * @param schema - Optional JSON schema; when given, the reply is constrained to match it.
   * @returns The reply text.
   * @throws QuotaExhaustedError on a 429; Error on any other failure.
   */
  call(system: string, prompt: string, maxTokens: number, schema?: JsonSchema): Promise<string>;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

/** Calls Claude through the official Anthropic SDK. Model: CLAUDE_MODEL (default claude-opus-5-5). */
export class AnthropicProvider implements LLMProvider {
  readonly model = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5';

  // The SDK retries 408/409/429/5xx and connection errors (2 retries by default).
  private readonly client: Anthropic;

  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) console.warn('[llm] ANTHROPIC_API_KEY is not set in .env');
    this.client = new Anthropic({ maxRetries: 2 });
  }

  async call(system: string, prompt: string, maxTokens: number, schema?: JsonSchema): Promise<string> {
    try {
      // Streaming, so large max_tokens values don't hit HTTP timeouts.
      const response = await this.client.beta.messages
        .stream({
          // On a safety refusal, the API re-runs the request on a fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          model: this.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: prompt }],
          ...(schema && { output_config: { format: { type: 'json_schema', schema } } }),
        })
        .finalMessage();

      if (response.stop_reason === 'refusal') {
        throw new Error(`Claude declined the request (${response.stop_details?.category ?? 'no category'})`);
      }
      if (response.stop_reason === 'max_tokens') {
        throw new Error('Response was cut off at max_tokens');
      }

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!text) throw new Error(`Claude returned no text (stop reason: ${response.stop_reason})`);
      return text;
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new Error(`Claude API authentication failed: check ANTHROPIC_API_KEY in .env (${error.message})`);
      }
      if (error instanceof Anthropic.RateLimitError) throw new QuotaExhaustedError(error.message);
      if (error instanceof Anthropic.APIError) throw new Error(`Claude API error ${error.status}: ${error.message}`);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/** Maximum time for a single Gemini call, in milliseconds. */
const GEMINI_TIMEOUT_MS = 120_000;

/** Backoff before each retry after a 504 DEADLINE_EXCEEDED, in milliseconds. */
const GEMINI_RETRY_DELAYS_MS = [10_000, 30_000];

/** Calls Gemini through @google/genai. Model: GEMINI_MODEL (default gemini-3.8-flash). */
export class GeminiProvider implements LLMProvider {
  readonly model = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';

  private readonly client: GoogleGenAI;

  constructor() {
    if (!process.env.GEMINI_API_KEY) console.warn('[llm] GEMINI_API_KEY is not set in .env');
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' });
  }

  async call(system: string, prompt: string, maxTokens: number, schema?: JsonSchema): Promise<string> {
    try {
      let response: GenerateContentResponse | undefined;
      for (let attempt = 1; !response; attempt += 1) {
        try {
          response = await this.generateOnce(system, prompt, maxTokens, schema);
        } catch (error) {
          if (attempt > GEMINI_RETRY_DELAYS_MS.length || !isDeadlineExceeded(error)) throw error;
          const delay = GEMINI_RETRY_DELAYS_MS[attempt - 1];
          console.warn(`  [llm] 504 DEADLINE_EXCEEDED, retrying in ${delay / 1000}s`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      const blockReason = response.promptFeedback?.blockReason;
      if (blockReason) throw new Error(`Gemini blocked the request (${blockReason})`);
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === FinishReason.SAFETY) throw new Error('Gemini declined the request (SAFETY)');
      if (finishReason === FinishReason.MAX_TOKENS) throw new Error('Response was cut off at max_tokens');

      const text = response.text;
      if (!text) throw new Error(`Gemini returned no text (finish reason: ${finishReason ?? 'unknown'})`);
      return text;
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401 || error.status === 403) {
          throw new Error(`Gemini API authentication failed: check GEMINI_API_KEY in .env (${error.message})`);
        }
        if (error.status === 429) throw new QuotaExhaustedError(error.message);
        throw new Error(`Gemini API error ${error.status}: ${error.message}`);
      }
      throw error;
    }
  }

  /** Makes one Gemini call, cancelled after GEMINI_TIMEOUT_MS. */
  private async generateOnce(
    system: string,
    prompt: string,
    maxTokens: number,
    schema?: JsonSchema,
  ): Promise<GenerateContentResponse> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Gemini call timed out after ${GEMINI_TIMEOUT_MS / 1000}s (model ${this.model})`));
      }, GEMINI_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.client.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            systemInstruction: system,
            maxOutputTokens: maxTokens,
            ...(schema && { responseMimeType: 'application/json', responseJsonSchema: schema }),
            abortSignal: controller.signal,
            httpOptions: { timeout: GEMINI_TIMEOUT_MS },
          },
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** True if the error is a 504 / DEADLINE_EXCEEDED from the Gemini API. */
function isDeadlineExceeded(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.status === 504) ||
    (error instanceof Error && error.message.includes('DEADLINE_EXCEEDED'))
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let cached: LLMProvider | null = null;

/**
 * Returns the provider named by LLM_PROVIDER in .env ('anthropic' or
 * 'gemini'; default 'anthropic'). The instance is cached.
 *
 * @returns The provider.
 * @throws If LLM_PROVIDER has an unsupported value.
 */
export function getProvider(): LLMProvider {
  if (cached) return cached;
  const name = (process.env.LLM_PROVIDER ?? 'anthropic').trim().toLowerCase();
  switch (name) {
    case 'anthropic':
      cached = new AnthropicProvider();
      break;
    case 'gemini':
      cached = new GeminiProvider();
      break;
    default:
      throw new Error(`Unsupported LLM_PROVIDER "${process.env.LLM_PROVIDER}" in .env: use 'anthropic' or 'gemini'`);
  }
  return cached;
}
