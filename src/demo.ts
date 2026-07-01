/**
 * Demo entrypoint.
 *
 * Runs five sample intents through the Verified Execution Agent:
 *   (A) a reasonable transfer            -> expected PASS  (executed, stub txHash)
 *   (B) zero-address + absurd amount     -> expected BLOCK (deterministic safety)
 *   (C) action contradicts rationale     -> expected BLOCK (LLM sanity check)
 *   (D) "small DEX approval" but calldata
 *       decodes approve(spender, 2^256-1) -> expected BLOCK (Calldata Guard: drainer)
 *   (E) "check balance" but calldata
 *       decodes transfer(attacker, 1000e6)-> expected BLOCK (Calldata Guard: hidden transfer)
 *
 * Run with:  npm run demo
 */

import { runDemo } from './agent.js';

runDemo().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
