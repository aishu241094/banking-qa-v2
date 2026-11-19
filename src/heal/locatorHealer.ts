import { callClaudeJson } from '../generators/claudeClient';

/** The LLM's suggested replacement for a broken locator. */
export interface HealResult {
  /** Playwright locator expression to try instead, e.g. getByRole('button', { name: 'Submit' }). */
  suggestedLocator: string;
  /** How sure the model is that the suggestion targets the same element. */
  confidence: 'high' | 'medium' | 'low';
  /** Why this locator was chosen, or why no confident alternative exists. */
  reasoning: string;
}

/** Maximum DOM characters sent to the LLM after trimming. */
const MAX_DOM_CHARS = 20_000;

/** JSON schema for the LLM's reply (structured outputs). */
const HEAL_SCHEMA = {
  type: 'object',
  properties: {
    suggestedLocator: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string' },
  },
  required: ['suggestedLocator', 'confidence', 'reasoning'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You repair broken Playwright locators for a banking web app's test suite.

You get a locator that failed, the Playwright error, and a DOM snapshot of the page. Work out which element the failed locator was meant to find, then find that element in the DOM and write a better Playwright locator for it.

Prefer, in this order: getByRole with an accessible name, getByLabel, getByTestId, getByText, and only then a CSS locator('...'). Write the locator as a Playwright expression starting at page, e.g. page.getByRole('button', { name: 'Submit transfer' }).

Only suggest an element that is actually in the DOM snapshot. Confidence:
- high: the element is clearly the one the failed locator meant, and the new locator matches exactly one element.
- medium: a likely match, but the intent of the failed locator or the uniqueness of the new one is uncertain.
- low: no element in the DOM clearly matches. In that case set suggestedLocator to an empty string, or to your best guess, and explain in reasoning what is missing.

Do not invent attributes, ids or text that are not in the DOM.`;

/**
 * Shrinks a DOM snapshot before it goes to the LLM: drops scripts, styles,
 * comments and SVG contents, collapses whitespace, and caps the length.
 *
 * @param dom - Raw HTML.
 * @returns The trimmed HTML.
 */
export function trimDom(dom: string): string {
  const trimmed = dom
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '<svg></svg>')
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed.length > MAX_DOM_CHARS
    ? `${trimmed.slice(0, MAX_DOM_CHARS)} <!-- DOM truncated at ${MAX_DOM_CHARS} characters -->`
    : trimmed;
}

/**
 * Asks the LLM for a better locator for the element a failed locator was
 * meant to find, based on the page's DOM.
 *
 * @param failedLocator - The locator that failed, e.g. "locator('#submit-btn')".
 * @param domSnapshot - HTML of the page at the time of failure.
 * @param errorMessage - The Playwright error message.
 * @returns The suggestion. Confidence is 'low' when no confident alternative exists.
 * @throws If the inputs are empty or the LLM call fails.
 */
export async function healLocator(failedLocator: string, domSnapshot: string, errorMessage: string): Promise<HealResult> {
  try {
    if (!domSnapshot.trim()) throw new Error('domSnapshot must not be empty');

    const result = await callClaudeJson<HealResult>({
      system: SYSTEM_PROMPT,
      prompt: [
        `<failed_locator>${failedLocator || '(could not be extracted from the error)'}</failed_locator>`,
        `<error_message>\n${errorMessage}\n</error_message>`,
        `<dom_snapshot>\n${trimDom(domSnapshot)}\n</dom_snapshot>`,
        '',
        'Suggest a better locator for the element the failed locator was meant to find.',
      ].join('\n'),
      schema: HEAL_SCHEMA,
      maxTokens: 4000,
    });

    // Without a locator there is nothing to try, whatever the model said.
    if (!result.suggestedLocator.trim()) return { ...result, confidence: 'low' };
    return result;
  } catch (error) {
    throw new Error(`healLocator failed: ${(error as Error).message}`);
  }
}
