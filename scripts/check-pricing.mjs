#!/usr/bin/env node
/**
 * check-pricing.mjs
 *
 * Fetches Anthropic docs and compares per-token prices to MODEL_PRICING in
 * container/agent-runner/src/index.ts.
 *
 * Runs weekly (Monday 09:00 Helsinki / 07:00 UTC) via systemd timer.
 *
 * On mismatch: writes an IPC message so Annie is notified via Telegram.
 * On match:    logs "Pricing verified, no changes" to /tmp/pricing-check.log
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX_TS = path.join(ROOT, 'container', 'agent-runner', 'src', 'index.ts');
const IPC_MESSAGES = path.join(ROOT, 'data', 'ipc', 'telegram_main', 'messages');
const LOG_FILE = '/tmp/pricing-check.log';
const CHAT_JID = 'tg:8734325292';

// Column order in the "Latest models comparison" table on the docs page.
// This must stay in sync with the actual table column order on the page.
const TABLE_COLUMN_ORDER = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}

// ── Parse MODEL_PRICING from index.ts ─────────────────────────────────────

function parseCodedPricing() {
  const src = fs.readFileSync(INDEX_TS, 'utf-8');
  // Match the full MODEL_PRICING block (handles nested braces)
  const blockMatch = src.match(/const MODEL_PRICING[^=]*=\s*(\{[\s\S]*?\n\};)/);
  if (!blockMatch) throw new Error('Could not find MODEL_PRICING block in index.ts');

  const pricing = {};
  const lineRe = /'([^']+)':\s*\{\s*input:\s*([\d.]+),\s*output:\s*([\d.]+)/g;
  let m;
  while ((m = lineRe.exec(blockMatch[1])) !== null) {
    pricing[m[1]] = { input: parseFloat(m[2]), output: parseFloat(m[3]) };
  }
  if (Object.keys(pricing).length === 0) {
    throw new Error('MODEL_PRICING block found but no entries parsed');
  }
  return pricing;
}

// ── Fetch Anthropic docs page ─────────────────────────────────────────────

async function fetchDocsPage() {
  const url = 'https://docs.anthropic.com/en/docs/about-claude/models/overview';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; nanoclaw-pricing-check/1.0)',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const text = await res.text();
  log(`Fetched ${url} (${text.length} chars)`);
  return { url, text };
}

// ── Extract prices from "Latest models comparison" table ──────────────────

/**
 * The docs page has a comparison table with columns in this order:
 *   Claude Opus 4.6 | Claude Sonnet 4.6 | Claude Haiku 4.5
 *
 * The pricing row in that table shows "$N / input MTok<br/>$M / output MTok"
 * in each column cell. We find the table section and extract the three
 * input/output pairs in column order.
 *
 * Returns null if the table structure has changed.
 */
function extractComparisonTablePricing(text) {
  const tableHeading = 'Latest models comparison';
  const headingIdx = text.indexOf(tableHeading);
  if (headingIdx < 0) {
    log('WARNING: "Latest models comparison" heading not found on page');
    return null;
  }

  // Grab enough of the table section (the full table is ~15k chars)
  const section = text.slice(headingIdx, headingIdx + 20_000);

  // Extract all input/output price pairs in document order.
  // Prices appear as "$5 / input MTok" in the rendered HTML.
  const inputPrices = [...section.matchAll(/\$([\d.]+) \/ input MTok/g)].map(
    (m) => parseFloat(m[1]),
  );
  const outputPrices = [...section.matchAll(/\$([\d.]+) \/ output MTok/g)].map(
    (m) => parseFloat(m[1]),
  );

  if (inputPrices.length < TABLE_COLUMN_ORDER.length) {
    log(
      `WARNING: Expected ${TABLE_COLUMN_ORDER.length} input prices in table, found ${inputPrices.length}`,
    );
    return null;
  }

  const pricing = {};
  for (let i = 0; i < TABLE_COLUMN_ORDER.length; i++) {
    const model = TABLE_COLUMN_ORDER[i];
    pricing[model] = {
      input: inputPrices[i],
      output: outputPrices[i] ?? null,
    };
  }
  return pricing;
}

// ── Notify Annie via IPC ──────────────────────────────────────────────────

function notifyAnnie(text) {
  fs.mkdirSync(IPC_MESSAGES, { recursive: true });
  const id = `pricing-alert-${Date.now()}`;
  const msg = { type: 'message', chatJid: CHAT_JID, text };
  fs.writeFileSync(
    path.join(IPC_MESSAGES, `${id}.json`),
    JSON.stringify(msg, null, 2) + '\n',
  );
  log(`IPC notification written: ${id}.json`);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  log('=== Anthropic pricing check starting ===');

  let codedPricing;
  try {
    codedPricing = parseCodedPricing();
    log(`Coded pricing: ${JSON.stringify(codedPricing)}`);
  } catch (err) {
    log(`ERROR parsing index.ts: ${err.message}`);
    process.exit(1);
  }

  let fetched;
  try {
    fetched = await fetchDocsPage();
  } catch (err) {
    log(`ERROR fetching docs page: ${err.message}`);
    notifyAnnie(
      `⚠️ *Pricing check failed* — could not fetch Anthropic docs page.\n${err.message}\nManual verification needed: https://www.anthropic.com/pricing`,
    );
    process.exit(1);
  }

  const livePricing = extractComparisonTablePricing(fetched.text);

  if (!livePricing) {
    log('WARNING: Could not extract prices from page — structure may have changed');
    notifyAnnie(
      `⚠️ *Pricing check: extraction failed*\n\nFetched the Anthropic docs page but couldn't parse per-token prices. The table layout may have changed — please verify manually:\nhttps://www.anthropic.com/pricing\n\nCurrent coded prices:\n${
        Object.entries(codedPricing)
          .map(([m, p]) => `• ${m}: $${p.input}/$${p.output} per MTok`)
          .join('\n')
      }`,
    );
    process.exit(0);
  }

  log(`Live pricing (from docs comparison table): ${JSON.stringify(livePricing)}`);

  const diffs = [];
  for (const [model, coded] of Object.entries(codedPricing)) {
    const live = livePricing[model];
    if (!live) {
      log(`SKIP: ${model} not in comparison table (possibly renamed)`);
      continue;
    }
    const inputMismatch = live.input !== null && coded.input !== live.input;
    const outputMismatch = live.output !== null && coded.output !== live.output;
    if (inputMismatch || outputMismatch) {
      diffs.push(
        `*${model}*:\n  coded:  input=$${coded.input}  output=$${coded.output} /MTok\n  live:   input=$${live.input}  output=$${live.output} /MTok`,
      );
    }
  }

  if (diffs.length > 0) {
    const alertText = [
      '🚨 *MODEL\\_PRICING mismatch detected!*',
      '',
      'The prices in `container/agent-runner/src/index.ts` appear outdated:',
      '',
      diffs.join('\n\n'),
      '',
      'Please update MODEL\\_PRICING and rebuild the container.',
      `Source: ${fetched.url}`,
    ].join('\n');
    log(`MISMATCH FOUND: ${diffs.length} model(s) differ`);
    notifyAnnie(alertText);
  } else {
    log('Pricing verified, no changes detected');
    log(`Source: ${fetched.url}`);
  }

  log('=== Pricing check complete ===');
}

main().catch((err) => {
  log(`FATAL: ${err.message}\n${err.stack}`);
  process.exit(1);
});
