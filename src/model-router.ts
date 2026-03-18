/**
 * Model routing — selects the Claude model based on message complexity.
 * Used by both container-runner (initial spawn) and index.ts (follow-up IPC).
 */
import fs from 'fs';
import path from 'path';

const MODEL_OVERRIDE_PATH = path.join(
  process.cwd(),
  'data',
  'model-override.txt',
);

/**
 * Classify message complexity. Routes to haiku or sonnet.
 * Only returns valid Anthropic Claude model names.
 */
export function classifyModel(prompt: string): string {
  // CC messages always use Sonnet — they require reliable rule-following
  // (acknowledge before acting, test fixes, update issues.md, etc.)
  if (/⚙️\s*\*CC:\*/u.test(prompt)) return 'claude-sonnet-4-6';

  const isComplex =
    prompt.length > 500 ||
    /```[\s\S]{200,}```/.test(prompt) ||
    /https?:\/\//.test(prompt) ||
    /\b(debug|analyze|explain|review|architect|design|research|investigate|implement|refactor|migrate)\b/i.test(
      prompt,
    );

  return isComplex ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
}

/**
 * Resolve the model to use: manual override > auto-classification.
 */
export function resolveModel(prompt: string): string {
  try {
    const override = fs.readFileSync(MODEL_OVERRIDE_PATH, 'utf-8').trim();
    if (override) return override;
  } catch {
    /* no override, use auto */
  }
  return classifyModel(prompt);
}
