// Checks that retrieve() loads data/requirements/ on its own in a fresh process.
// No LLM calls. Run from anywhere: node scripts/autoload-check.cjs
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root); // ingest reads data/requirements/ relative to the working directory

require('ts-node').register({ project: path.join(root, 'tsconfig.json'), transpileOnly: true });
const { retrieve } = require(path.join(root, 'src', 'rag', 'embedder'));

(async () => {
  // Two parallel queries: the store should load once, not twice.
  const [a, b] = await Promise.all([retrieve('IMPS daily transfer limit', 2), retrieve('AML review', 2)]);
  console.log('IMPS ->', a.length, 'chunks:', a[0].slice(0, 90).replace(/\s+/g, ' '));
  console.log('AML  ->', b.length, 'chunks:', b[0].slice(0, 90).replace(/\s+/g, ' '));

  // Third query: should reuse the loaded store (no second "loading" line).
  const c = await retrieve('KYC documents', 1);
  console.log('3rd call (no reload expected) ->', c.length);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
