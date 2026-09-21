import { AiAnalysisResult } from './ai-provider.interface';

export interface SafetyCheckResult {
  flagged: boolean;
  pattern?: string;
}

/**
 * AI_INTEGRATION_SPEC.md §4 — the second, independent layer. Schema-shape
 * validation (validate-ai-result.ts) only proves the response HAS the right
 * fields; it says nothing about what's written INSIDE them. This is a fixed,
 * reviewable list, not a model call — a match is a hard withhold (the AI
 * text never reaches Telegram at all), never a redact-and-send, because
 * partially-redacted advice is still advice with the verb missing.
 *
 * Deliberately reviewed and extended over time (AI_INTEGRATION_SPEC.md §4) —
 * this list is a starting point, not a claim of completeness.
 */
const FLAGGED_PATTERNS: RegExp[] = [
  /\byou should\b/i,
  /\byou (ought|need) to\b/i,
  /\bconsider (opening|closing|buying|selling|reducing|increasing)\b/i,
  /\b(buy|sell) now\b/i,
  /\brecommend(ed|s|ation)?\b/i,
  /\bi('d| would) (suggest|advise)\b/i,
  /\bnext step\b/i,
  /\b(close|open|reduce|increase|cut) (your|the) position\b/i,
  /\bstop trading\b/i,
  /\btake profit\b/i,
  /\bset (a |your )?stop.?loss\b/i,
];

function scanField(value: string): string | null {
  for (const pattern of FLAGGED_PATTERNS) {
    if (pattern.test(value)) return pattern.source;
  }
  return null;
}

/**
 * Scans every free-text field/sub-field of a schema-valid AiAnalysisResult.
 *
 * Market intelligence phase 6 added `recommended_action` to the schema —
 * deliberately NOT included in the list below. It's a closed four-value
 * enum (validate-ai-result.ts rejects anything else before this function
 * ever runs), never free text a model could slip an instruction into, so
 * there is nothing for a keyword scan to usefully check; scanning it would
 * only risk a false positive against one of its own value names. The new
 * `assessment` field IS free text and IS scanned, same as the original
 * three — market intelligence phase 6 extended what the AI is asked for,
 * not what's allowed to say it.
 */
export function checkSafety(result: AiAnalysisResult): SafetyCheckResult {
  const fields = [result.situation_summary, result.historical_comparison, result.statistical_context, result.assessment];
  for (const event of result.similar_past_events ?? []) {
    fields.push(event.brief_outcome);
  }

  for (const field of fields) {
    if (typeof field !== 'string') continue;
    const pattern = scanField(field);
    if (pattern) return { flagged: true, pattern };
  }
  return { flagged: false };
}
