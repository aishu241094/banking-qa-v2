import { promises as fs } from 'fs';
import * as path from 'path';
import { retrieve } from '../rag/embedder';
import { callClaudeJson } from './claudeClient';

/** Folder where generated files are written. */
export const OUTPUT_DIR = path.resolve(process.cwd(), 'outputs', 'generated_tests');

/** Folder holding the project's existing Page Object classes. */
const PAGES_DIR = path.resolve(process.cwd(), 'pages');

/** Number of requirement chunks pulled from ChromaDB as context. */
const TOP_K = 5;

/** The three artifacts Claude returns for one feature. */
export interface GeneratedArtifacts {
  /** Gherkin feature file content. */
  featureFile: string;
  /** Cucumber step definitions (TypeScript). */
  stepDefinitions: string;
  /** Playwright Page Object class (TypeScript). */
  pageObject: string;
  /** PascalCase class name of the page object, e.g. "ImpsTransferPage". */
  pageObjectClassName: string;
}

/** Paths of the files written by generateTests(). */
export interface GeneratedTestPaths {
  featureFile: string;
  stepDefinitions: string;
  pageObject: string;
}

/** JSON schema Claude's response must match (structured outputs). */
const ARTIFACTS_SCHEMA = {
  type: 'object',
  properties: {
    featureFile: { type: 'string', description: 'Complete Gherkin .feature file' },
    stepDefinitions: { type: 'string', description: 'Complete Cucumber step definitions .ts file' },
    pageObject: { type: 'string', description: 'Complete Playwright Page Object .ts file' },
    pageObjectClassName: { type: 'string', description: 'PascalCase class name ending in "Page"' },
  },
  required: ['featureFile', 'stepDefinitions', 'pageObject', 'pageObjectClassName'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are a senior QA automation engineer for a UK retail bank. You write Playwright + Cucumber BDD tests in TypeScript.

Banking rules every test must respect:
- IMPS: maximum £5,000 per transaction and £10,000 per day.
- NEFT: maximum £50,000 per day.
- RTGS: minimum £200,000 per transaction.
- AML: any transaction ABOVE £5,000 must be flagged for AML review. A transaction of exactly £5,000 is allowed and is NOT flagged.

Cover the happy path, each limit at its boundary (exactly at, just below, just above), and the AML flag. Use Scenario Outline with Examples tables for boundary values.

Code conventions:
- Page Object Model. Page objects live in pages/ and extend BasePage (import BasePage from './BasePage'). BasePage takes a Playwright Page in its constructor, exposes it as this.page, and provides navigate(url), waitForLoad() and takeScreenshot(name). Export the class both named and as default.
- Page objects expose Locators as readonly fields and user actions as async methods. No assertions inside page objects.
- Step definitions live in step-definitions/, import page objects from '../pages/<ClassName>', use Given/When/Then from '@cucumber/cucumber' and expect from '@playwright/test', and type this as CustomWorld (import { CustomWorld } from './world'), which provides this.page and this.browser. Do not launch or close the browser in steps; world.ts does that.
- Prefer getByRole / getByLabel / getByTestId locators over CSS selectors.
- Every Gherkin step must have a matching step definition.

Base the scenarios on the requirements given. Where they are silent, apply the banking rules above and do not invent other limits.`;

/**
 * Turns a feature name into a file-safe kebab-case slug.
 *
 * @param name - Free-text feature name, e.g. "IMPS Transfer".
 * @returns A slug such as "imps-transfer".
 * @throws If the name contains no letters or digits.
 */
function toSlug(name: string): string {
  try {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) throw new Error('feature name must contain letters or digits');
    return slug;
  } catch (error) {
    throw new Error(`Invalid feature name "${name}": ${(error as Error).message}`);
  }
}

/**
 * Lists the existing page object files so Claude can match the project structure.
 *
 * @returns File names in pages/, or an empty array if the folder is missing.
 */
async function listExistingPages(): Promise<string[]> {
  try {
    const entries = await fs.readdir(PAGES_DIR);
    return entries.filter((f) => f.endsWith('.ts'));
  } catch {
    return [];
  }
}

/**
 * Builds the user prompt from the feature name, retrieved requirements and
 * existing page objects.
 *
 * @param featureName - The feature to generate tests for.
 * @param requirements - Requirement chunks retrieved from ChromaDB.
 * @param existingPages - File names already present in pages/.
 * @returns The prompt text.
 */
export function buildPrompt(featureName: string, requirements: string[], existingPages: string[]): string {
  try {
    const context = requirements.length
      ? requirements.map((r, i) => `<requirement index="${i + 1}">\n${r}\n</requirement>`).join('\n')
      : '<requirement>No matching requirements were found. Use the banking rules only.</requirement>';

    return [
      `Generate tests for the feature: "${featureName}".`,
      '',
      '<requirements>',
      context,
      '</requirements>',
      '',
      `Existing page objects in pages/: ${existingPages.length ? existingPages.join(', ') : '(none yet)'}`,
      'Reuse their naming style. Create a new page object for this feature rather than editing those.',
      '',
      'Return the Gherkin feature file, the step definitions file, the page object file, and the page object class name.',
    ].join('\n');
  } catch (error) {
    throw new Error(`Failed to build prompt: ${(error as Error).message}`);
  }
}

/**
 * Sends the prompt to Claude and returns the three generated files.
 *
 * @param prompt - The user prompt from buildPrompt().
 * @returns The generated artifacts.
 * @throws On any Claude failure, or if the class name is not a safe file name.
 */
async function callClaude(prompt: string): Promise<GeneratedArtifacts> {
  try {
    const artifacts = await callClaudeJson<GeneratedArtifacts>({
      system: SYSTEM_PROMPT,
      prompt,
      schema: ARTIFACTS_SCHEMA,
    });
    if (!/^[A-Z][A-Za-z0-9]*$/.test(artifacts.pageObjectClassName)) {
      throw new Error(`Invalid page object class name "${artifacts.pageObjectClassName}"`);
    }
    return artifacts;
  } catch (error) {
    throw new Error(`Failed to generate tests with the LLM: ${(error as Error).message}`);
  }
}

/**
 * Generates a Gherkin feature file, Cucumber step definitions and a Playwright
 * Page Object for a banking feature, using requirements retrieved from ChromaDB
 * as context, and saves them to outputs/generated_tests/.
 *
 * @param featureName - The feature to test, e.g. "IMPS transfer".
 * @returns Paths of the three saved files.
 * @throws If retrieval, generation, or writing the files fails.
 */
export async function generateTests(featureName: string): Promise<GeneratedTestPaths> {
  try {
    const slug = toSlug(featureName);
    const [requirements, existingPages] = await Promise.all([
      retrieve(featureName, TOP_K),
      listExistingPages(),
    ]);

    const artifacts = await callClaude(buildPrompt(featureName, requirements, existingPages));

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const paths: GeneratedTestPaths = {
      featureFile: path.join(OUTPUT_DIR, `${slug}.feature`),
      stepDefinitions: path.join(OUTPUT_DIR, `${slug}.steps.ts`),
      pageObject: path.join(OUTPUT_DIR, `${artifacts.pageObjectClassName}.ts`),
    };

    await Promise.all([
      fs.writeFile(paths.featureFile, artifacts.featureFile, 'utf-8'),
      fs.writeFile(paths.stepDefinitions, artifacts.stepDefinitions, 'utf-8'),
      fs.writeFile(paths.pageObject, artifacts.pageObject, 'utf-8'),
    ]);

    return paths;
  } catch (error) {
    throw new Error(`generateTests("${featureName}") failed: ${(error as Error).message}`);
  }
}

// Run directly: npm run generate:tests -- "IMPS transfer"
if (require.main === module) {
  const featureName = process.argv.slice(2).join(' ').trim();
  if (!featureName) {
    console.error('Usage: npm run generate:tests -- "<feature name>"');
    process.exit(1);
  }
  generateTests(featureName)
    .then((paths) => {
      console.log('Generated files:');
      Object.values(paths).forEach((p) => console.log(`  ${p}`));
    })
    .catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
}
