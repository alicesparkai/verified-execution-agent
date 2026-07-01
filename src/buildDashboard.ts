/**
 * Dashboard builder.
 *
 * Reads the current reliability ledger (ledger.jsonl) and injects it into
 * `dashboard.template.html`, producing a single, fully self-contained
 * `dashboard.html` that opens offline by double-click (no server, no CDN).
 *
 * The template carries a placeholder string assigned to `window.__LEDGER__`;
 * we replace that placeholder with the live ledger JSON so the dashboard's
 * vanilla JS can render the verified-execution trail from real data.
 *
 * Run with:  npm run dashboard      (regenerate from the current ledger)
 *            npm run demo:full      (run the demo, then regenerate)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readLedger } from './ledger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root (one level up from /src or /dist). */
const ROOT = join(__dirname, '..');
const TEMPLATE_PATH = join(ROOT, 'dashboard.template.html');
const OUTPUT_PATH = join(ROOT, 'dashboard.html');

/** The exact quoted placeholder token in the template (including its quotes). */
const PLACEHOLDER = '"__LEDGER_DATA_PLACEHOLDER__"';

function buildDashboard(): void {
  if (!existsSync(TEMPLATE_PATH)) {
    throw new Error(`Template not found: ${TEMPLATE_PATH}`);
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(
      `Placeholder ${PLACEHOLDER} not found in template — cannot inject ledger data.`,
    );
  }

  const entries = readLedger();

  // Pretty-printed so the generated file stays human-readable / diff-friendly.
  // JSON is valid JS here, so it drops straight into the assignment.
  const injected = JSON.stringify(entries, null, 2);

  const html = template.replace(PLACEHOLDER, injected);
  writeFileSync(OUTPUT_PATH, html, 'utf8');

  const passed = entries.filter((e) => e.verdict.decision === 'PASS').length;
  const blocked = entries.length - passed;
  console.log(
    `Dashboard written: ${OUTPUT_PATH}\n` +
      `  ${entries.length} ledger entrie(s) injected — ${passed} PASS / ${blocked} BLOCK.\n` +
      `  Open it by double-clicking (works offline, no server needed).`,
  );
}

buildDashboard();
