/**
 * Demo entrypoint.
 *
 * Runs three sample intents through the Verified Execution Agent:
 *   (A) a reasonable transfer          -> expected PASS  (executed, stub txHash)
 *   (B) zero-address + absurd amount   -> expected BLOCK (deterministic safety)
 *   (C) action contradicts rationale   -> expected BLOCK (LLM sanity check)
 *
 * Run with:  npm run demo
 */

import { runDemo } from './agent.js';

runDemo().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
