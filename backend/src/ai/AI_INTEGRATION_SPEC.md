# AI Integration specification — Phase 6
> See `../../../PROJECT_STATUS.md` at the repo root for the authoritative build order, phase-numbering crosswalk, and current status of every component.

Status: **Implemented and tested. §11's four open decisions were resolved (two messages;
first-alert-only narration; approximate similar-past-events; Anthropic/claude-sonnet-5) and built
exactly as designed. Two implementation bugs found by the test suite itself, fixed before sign-off —
see the addendum at the end of this document.**

Written against the already-approved Phase 0 architecture (§10, Req. 2/3/11), the completed
`rules`/`alerts`/`telegram` modules, and the current Prisma schema. Nothing here reopens the Rule
Engine, `AlertLifecycleService`, or the Phase 5 delivery pipeline — this phase is additive only.

## 0. The boundary, restated

This has been said in every phase so far and doesn't change here:

- The **Rule Engine** is the only component that decides whether an alert exists (Phase 4, unchanged).
- **AlertLifecycleService**'s cooldown/dedup logic is the only thing that decides whether a
  *notification* fires (Phase 4, unchanged).
- AI is consulted **after** both of those decisions are already final, reads only what already
  happened, and produces **narration, never instruction**. There is no code path by which an AI
  response can create an `Alert` row, change a `RuleState`, or place/modify/close a trade — none of
  those capabilities exist in the `ai` module's dependency graph at all (§5).
- If the AI call fails, times out, is disabled, or returns something that doesn't fit the schema in
  §2, **the deterministic alert already sent in Phase 5 is unaffected.** AI is a pure enrichment;
  its absence is never a delivery failure.

## 1. Where this sits in the pipeline — the actual design decision for this phase

Phase 0's diagram draws `Alert → AI → Telegram` as one line, which reads as AI sitting *inline*
before the single Telegram send. But Phase 5 was built specifically so Telegram delivery never
waits on anything slow or unreliable (RULE_ENGINE_SPEC.md's sibling principle, restated for
delivery: *"The Rule Engine must NOT synchronously wait for Telegram"* — by the same logic, Telegram
delivery must not synchronously wait on an AI provider either). An LLM call is multi-second at best,
occasionally down, occasionally rate-limited — putting it in front of the *first* message would
reintroduce exactly the coupling Phase 5 eliminated.

**Recommended: two independent messages, not one enriched message.**

```
                                    (Phase 5, unchanged, unblocked by any of this)
Rule Engine → Alert → AlertDelivery → Delivery Queue → Telegram   [message #1: deterministic, fast]
                 │
                 └──→ AiAnalysis (NEW) → AI Queue → AI provider → safety filter → Telegram   [message #2: narrative, best-effort]
```

Message #1 (already shipped, Phase 5) is the trader's actual alert — the numbers, unfiltered by AI
latency. Message #2 is a follow-up, sent only if the AI call succeeds and passes the safety filter,
arriving anywhere from a few seconds to (if the provider is having a bad day) not at all. This is a
strictly additive pipeline: it touches zero lines in `alerts/` or the existing `telegram/` delivery
code, which is precisely why it's the lower-risk shape for a phase whose entire brief is "don't let
this thing anywhere near a decision." Flagged in §11 as the one open call I'd like your sign-off on
before building — the alternative (block message #1 on AI, one combined message) is described there
too.

## 2. `AiProvider` interface — provider abstraction (Phase 0 §10, Req. 11)

```ts
// ai/ai-provider.interface.ts
export interface AlertContext {
  alertId: string;
  ruleType: RuleType;
  ruleName: string;
  triggerValues: Record<string, unknown>;   // Alert.triggerValues, verbatim
  baselineSnapshot: Record<string, unknown>; // Alert.baselineSnapshot, verbatim
  triggeredAt: Date;
  similarPastEvents: SimilarPastEvent[];     // §6
}

export interface AiAnalysisResult {
  situation_summary: string;
  historical_comparison: string;
  similar_past_events: { alert_id: string; triggered_at: string; brief_outcome: string }[];
  statistical_context: string;
}

export interface AiProvider {
  analyze(context: AlertContext): Promise<AiAnalysisResult>;
}
```

Selected at startup by config, exactly like Phase 5's Telegram config validation:

```
AI_PROVIDER=anthropic
AI_MODEL=claude-sonnet-5
ANTHROPIC_API_KEY=...
AI_REQUEST_TIMEOUT_MS=60000
```

`rules`, `alerts`, and `telegram` depend on nothing here — only a new `ai` module depends on
`AiProvider`, and only `AiProvider`'s **interface**, never a concrete provider class by name. Adding
a second provider later (or changing `AI_MODEL`) touches `ai/` and a config value, nothing else —
same guarantee Phase 5 gives for the Telegram/BullMQ boundary.

## 3. Output schema — no recommendation field, structurally (Phase 0 §10, Req. 3)

The `AiAnalysisResult` shape above is exhaustive — `situation_summary`, `historical_comparison`,
`similar_past_events`, `statistical_context`. There is no `recommendation`, `action`, or
`suggested_next_step` field **in the type**, not omitted by convention. A provider's raw response is
parsed against this exact shape (e.g. via a `zod` schema or `class-validator` on a DTO — matching
the pattern `rules/dto/validate-rule-parameters.ts` already established); a response that doesn't
fit it is rejected before it reaches Telegram, the same as any other schema-validated boundary in
this system.

## 4. Deterministic post-filter — the second, independent layer (Phase 0 §10)

Schema-shape validation (§3) doesn't stop imperative language *inside* an otherwise-descriptive
free-text field — `situation_summary` could legitimately be schema-valid and still contain "you
should reduce your position size." A keyword/regex filter runs over all four free-text
fields/sub-fields before anything is sent:

```ts
// ai/safety-filter.ts — a fixed, reviewable list, not an LLM call
const FLAGGED_PATTERNS = [
  /\byou should\b/i, /\bconsider (opening|closing|buying|selling)\b/i,
  /\bbuy now\b/i, /\bsell now\b/i, /\brecommend(ed)?\b/i,
  /\bi('d| would) (suggest|advise)\b/i, /\bnext step\b/i,
  // deliberately reviewed and extended over time — see §9
];
```

A match sets `AiAnalysis.safetyFlagged = true` and withholds the AI text from Telegram entirely —
message #2 (§1) simply never sends for that alert. This is a hard withhold, not a redaction-and-send:
partially-redacted advice is still advice with the verb missing, not a safe message.

## 5. Schema addition

```prisma
enum AiAnalysisStatus {
  PENDING
  READY       // generated, passed the safety filter, sent (or ready to send)
  WITHHELD    // generated, FAILED the safety filter — never sent, kept for audit
  FAILED      // provider error / timeout / schema-invalid response; may retry
}

model AiAnalysis {
  id             String            @id @default(uuid())
  alertId        String            @unique @map("alert_id")
  status         AiAnalysisStatus  @default(PENDING)
  provider       String            // e.g. "anthropic" — which AiProvider answered, for audit
  model          String            // e.g. "claude-sonnet-5"
  result         Json?             // the validated AiAnalysisResult, once READY (null otherwise)
  safetyFlagged  Boolean           @default(false) @map("safety_flagged")
  flaggedPattern String?           @map("flagged_pattern") // which rule matched, for review — never the full withheld text in logs
  lastError      String?           @map("last_error")
  attempts       Int               @default(0)
  telegramMessageId Int?           @map("telegram_message_id") // message #2's id, once sent
  createdAt      DateTime          @default(now()) @map("created_at")
  updatedAt      DateTime          @updatedAt @map("updated_at")

  alert Alert @relation(fields: [alertId], references: [id], onDelete: Cascade)

  @@index([status, createdAt])
  @@map("ai_analyses")
}
```

Same shape as `AlertDelivery` deliberately — `alertId @unique`, one row per alert, status machine,
`attempts`/`lastError` for the same retry/observability reasons (§7). Add `Alert.aiAnalysis
AiAnalysis?` as the back-relation. No changes to any Phase 1–5 table.

## 6. `similar_past_events` — a real gap, flagged in Phase 4, resolved here

`RuleState` only tracks the *most recent* resolution (`resolvedAt`), not a per-episode history — I
flagged this explicitly in `RULE_ENGINE_SPEC.md` §12.12 point 5 as "derivable later... not something
Phase 4 needs to solve." Phase 6 is where it's needed. Two options:

- **(a) Minimal, for v1:** `similarPastEvents` = the account's last 3 `Alert` rows for the *same
  `ruleId`* (excluding this one), with `brief_outcome` derived as "resolved after ~N minutes" by
  finding the next `Alert` row for that same rule with a later `triggeredAt` (a rough proxy — not
  exact episode boundaries, since re-notify alerts within one continuous episode also have distinct
  `triggeredAt` values, §5 of `RULE_ENGINE_SPEC.md`). Cheap, no new table, slightly imprecise for a
  rule that re-notified multiple times within one episode.
- **(b) Precise:** reconstruct true episode boundaries from `RuleState` history by also logging every
  `INACTIVE→ACTIVE`/`ACTIVE→INACTIVE` transition (a new small append-only table,
  `rule_state_transitions`) — Phase 4 doesn't currently log transitions, only current state. Accurate
  "resolved within 40 minutes, no further alerts" language, more schema.

**Recommend (a) for Phase 6** — it's honest about being an approximation (the copy says "resolved
after ~N minutes," not a precise claim), costs nothing structurally, and (b) can replace it later
without changing `AiProvider`'s interface at all. Flagged in §11 for your call.

## 7. Failure handling & retry

Mirrors Phase 5's shape exactly, at smaller scale:

- Provider error, timeout (`AI_REQUEST_TIMEOUT_MS`), or a response that fails schema validation (§3)
  → `AiAnalysis.status = FAILED`, `attempts += 1`, `lastError` set (provider API keys redacted the
  same way `TELEGRAM_BOT_TOKEN` is, §9).
- A small number of retries with backoff (reuse the `jobs` module's queue infrastructure — a second
  BullMQ queue, `ai-analysis`, or a second job type on the existing queue; **no new infrastructure
  class**, same Redis, same Worker pattern). Unlike Telegram delivery, there's no reconciliation
  sweep requirement here — a `FAILED` `AiAnalysis` that never got its follow-up sent is a missed
  narrative, not a missed alert (message #1 already went out), so a smaller, simpler retry budget is
  appropriate (proposed: 2 attempts, not 5).
- No `DEAD` state needed — `FAILED` after exhausting retries is the terminal state; nothing
  operationally urgent depends on it the way a `DEAD` trading alert would.

## 8. Cost & volume — an open question, not a technical one

Every `Alert` row (§5) would get an `AiAnalysis` row 1:1, including cooldown re-notifies of the same
ongoing episode (`RULE_ENGINE_SPEC.md` §5 — a condition that stays true for an hour under a 30-minute
cooldown produces multiple `Alert` rows). Each is a paid API call. Options:

- Generate AI narration only for the **first** alert in an episode (`RuleState` transitioning
  `INACTIVE→ACTIVE`), not every re-notify — the trader already has the context from message #1 the
  first time; a re-notify's "situation" hasn't materially changed.
- Generate for every alert regardless (simplest, highest cost).

**Recommend the first** — cheaper, and a repeated AI narrative for an unchanged situation adds noise
without adding information. Flagged for your call in §11.

## 9. Security (same posture as Phase 5, Req. 9's pattern applied to a new secret)

- `ANTHROPIC_API_KEY` only from environment, validated at startup (`ai` module's config loader fails
  fast exactly like `telegram.config.ts` does today) — the app refuses to boot with AI enabled and no
  key.
- Never logged: the same `redactToken`-style helper Phase 5 built for the bot token is reused (moved
  to a shared `common/redact.ts` rather than duplicated — the one cross-module refactor this phase
  needs, and a small one).
- Never exposed via any API response — no HTTP endpoint returns provider config, same as Telegram.
- **Withheld AI text is never logged in full** — `AiAnalysis.flaggedPattern` records *which* rule
  matched (for reviewing the filter's own false-positive/negative rate over time), not the withheld
  content itself in application logs (it does stay in `AiAnalysis.result` in Postgres for audit,
  access-controlled the same as every other table — logs and the database are different exposure
  surfaces).

## 10. Testing strategy (mirrors Phase 5 — no live AI provider in automated tests)

- Pure unit tests: safety-filter pattern matching (crafted strings that should/shouldn't flag),
  schema validation (well-formed and malformed provider responses).
- `AiProvider` tests against a fake implementation (no real Anthropic API calls), same posture as
  Phase 5's `fetch` mock for Telegram.
- End-to-end: real `Alert` → `AiAnalysis` created → fake provider returns a valid result → safety
  filter passes → `status = READY` → (if message #2 is in scope for this phase) a second Telegram
  send recorded. A separate fake-provider test proves a flagged response never reaches
  `TelegramBotClient` at all.
- A live manual test against a real Anthropic key is the equivalent of Phase 5's real-bot check —
  optional, done once by you when you're ready, not required for automated coverage.

## 11. Open decisions needing your sign-off before I start building

1. **Two-message design (§1)** vs. a single combined message that waits on AI before sending
   anything. I've recommended two messages because it keeps Phase 5's "never block on something
   slow" guarantee intact — but it does mean a trader sometimes gets the narrative a few seconds (or
   never) after the raw alert, not together. Your call.
2. **`similar_past_events` precision (§6)** — approximate now (option a) vs. building real episode
   tracking first (option b, a small Phase 4 extension).
3. **Narrate every alert vs. only the first alert of an episode (§8)** — cost/noise trade-off.
4. Confirm **`AI_PROVIDER=anthropic` / `AI_MODEL=claude-sonnet-5`** as the actual default you want
   live (Phase 0's own recommendation, unchanged) — this is the first phase that spends real money
   per alert, worth an explicit yes.

**Resolved:** all four confirmed as recommended (two messages; first-alert-only; approximate
similar-past-events; Anthropic/claude-sonnet-5). Implemented exactly as designed — see the addendum
below.

---

## Addendum — implementation review

Built as specified: `AiAnalysis` created transactionally with a FRESH-episode `Alert` only
(`AlertLifecycleService`), a dedicated `AI_ANALYSIS_QUEUE` with its own smaller retry budget, the
`ai` module's worker generating and safety-filtering a result without ever calling Telegram itself,
and `telegram`'s existing delivery worker gaining one new job kind (`deliver-ai-narrative`) to send
message #2. `AI_ENABLED` defaults to `false` — every Phase 1–5 test runs completely unaffected; the
Phase 6 test suite opts a single test file's own app context into `AI_ENABLED=true` rather than
changing that default globally.

**Two real bugs found by the test suite, both fixed before sign-off:**

1. **`findSimilarPastEvents`'s "next alert" query didn't exclude the alert currently being
   analyzed.** For the past event immediately preceding the current one, the query found the
   *current* alert itself as "the next related alert" and reported a real elapsed-time gap to it —
   which is nonsensical (the current alert is happening right now, not a resolution of the one
   before it). Fixed by excluding `excludeAlertId` from that query too, not just from the initial
   "past events" list.
2. **`AiAnalysisProcessor`'s idempotency guard treated `FAILED` as a terminal status.** The guard
   (`if (status !== 'PENDING') return`) was meant to stop a *successfully completed* job from
   re-running, but `FAILED` is also set after every individual failed attempt — including ones
   BullMQ is about to retry (see the `AiAnalysisStatus` enum's own comment: "may retry"). The result:
   a transient failure's retry would see `status = 'FAILED'`, treat it as "already handled," and
   return without calling the provider again or incrementing `attempts` — silently freezing at
   attempt 1 forever, never reaching `FAILED` in the genuinely-terminal, retries-exhausted sense.
   Fixed by only treating `READY`/`WITHHELD`/`SKIPPED` as terminal; `PENDING` and `FAILED` both
   still reach the provider call. Caught by `test/ai/ai-pipeline.spec.ts` test 6 ("a provider that
   always fails exhausts retries and lands FAILED"), which stalled indefinitely until fixed — a good
   example of why that test polled for `attempts` reaching the ceiling rather than for `status`
   alone (the same test file's test 3 needed an analogous fix, for an unrelated race: `status =
   READY` is set *before* the narrative-send job is enqueued, so a test that stops waiting the
   moment it sees `READY` can catch the row before the actual Telegram send has happened).

Full backend suite: 248/248 passing (204 pre-existing + 44 new). Collector: 23/23, unaffected.
`tsc --noEmit`: clean.

---

## Addendum 2 — market intelligence phase 6: risk-context fields (§3 revised)

**§3's original "no recommendation field, structurally" rule is no longer absolute.** On explicit
sign-off (the alternative to this addendum was building a wholly separate model, never touching
`AiAnalysisResult` at all — rejected in favor of extending the existing, working pipeline), the
schema gained:

```ts
market_risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
exposure_risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
event_risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
news_sentiment: 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE' | 'MIXED';
confidence: number;        // 0-1
assessment: string;        // free text — safety-filtered exactly like the original three fields
recommended_action: 'MONITOR' | 'REDUCE_RISK' | 'AVOID_NEW_EXPOSURE' | 'REVIEW_POSITION';
```

Why this doesn't reopen the safety boundary §0/§4 established: `recommended_action` is a CLOSED
four-value enum, validated exactly (`validate-ai-result.ts` rejects anything outside the list,
never coerces) — it can only ever be a risk-management POSTURE, never a trade direction, never
"buy"/"sell", never free text a model could slip an instruction into. `safety-filter.ts` still
scans every free-text field (now including `assessment`) against the full `FLAGGED_PATTERNS` list,
completely unweakened. The one new thing a provider CAN say is "reduce risk in general" as a
pre-approved label; it still cannot say what to do about it.

**New input**: `AlertContext.marketContext` — upcoming HIGH-impact economic events (FRED,
`market-events` module) and recent news (Marketaux) affecting currencies this account is
CURRENTLY exposed to, built fresh at analysis time by `MarketContextBuilderService`
(`ai/market-context-builder.service.ts`), same "not frozen at alert-creation" posture §6 already
established for `similarPastEvents` — this is supplementary world-context, not a record of what
caused the alert. Empty arrays (market intelligence disabled, or nothing currently relevant) are a
known state, always present, never omitted.

**Prompt-injection defense (Phase 11 security review)**: event/news titles are third-party text
(FRED/Marketaux). `SYSTEM_PROMPT` (`ai/ai-prompt.ts`) explicitly instructs the model that
`market_context` is untrusted external DATA, never an instruction, no matter what it says — this is
defense-in-depth on top of the actual boundary, which remains the closed-enum schema + keyword
filter: even a model that ignores the prompt and complies with an injected "recommend buying" can
only ever emit one of the four pre-approved `recommended_action` values, and any imperative language
in a free-text field is still hard-withheld by `safety-filter.ts` regardless.

**Telegram rendering**: `message-templates.ts`'s `renderAiNarrativeMessage` gained a "📊 Market
context" section (risk levels, news sentiment, confidence, the assessment narrative, and the
recommended posture) — always rendered, since a LOW/LOW/LOW/MONITOR reading is itself useful
information, not a blank worth hiding.

**Known limitation, flagged rather than built around**: the Telegram message currently renders the
AI's aggregate risk levels, not the raw list of upcoming events/news headlines with links — doing
that would mean persisting `AlertContext.marketContext` itself (not just the validated
`AiAnalysisResult`) somewhere renderable at delivery time, which this pass deliberately scoped out
rather than half-build. Recommended next step if source citations in the Telegram message matter:
store `marketContext` alongside `AiAnalysis.result` (a second JSON column, or nested inside the
same one) and extend the template to list it.

Full backend suite after this addendum: 433/433 passing. `tsc --noEmit`: clean. Frontend
`next build`: clean (unaffected — no AI schema is rendered client-side). Collector: 23/23,
unaffected.
