/**
 * scripts/first-touch-study.ts — NOT YET RUNNABLE. SUPERSEDED (2026-09-14)
 * by `scripts/confirmed-retest-study.ts` (`xauusd-h4-confirmed-retest-v1`);
 * see src/research/confirmed-retest/ENGINE_AUDIT.md for why this engine's
 * earlier results must not be cited.
 *
 * Entry-point stub for the eventual XAUUSD (gold) "first-touch" hypothesis
 * study. The engine (`src/research/first-touch/engine.ts`) and statistics
 * layer (`src/research/first-touch/statistics.ts`) are implemented and
 * covered by tests against SYNTHETIC fixtures only
 * (`test/research/first-touch/*.spec.ts`) — this script intentionally does
 * not run a real study, because:
 *
 *  - No real gold price data exists in this project yet, and none is
 *    fabricated here or anywhere else in this module.
 *  - No level-selection method has been approved.
 *    `proposed-swing-detector.ts`'s `PROPOSED_SWING_DETECTOR` is an
 *    explicitly unapproved placeholder used only by this module's own
 *    tests — it is not a candidate for a real run.
 *  - This engine must never share a runtime path with either live trading
 *    strategy (`src/trend-breakout/`, `src/autonomous/`) — this script
 *    does not import from either, and never will.
 *
 * Do not extend this file to perform a real run, and do not wire it into
 * any scheduled job, without both a resolved level-selection method and
 * real data explicitly approved for this purpose.
 */

function main(): never {
  throw new Error(
    'first-touch-study: not yet runnable — level-selection method unresolved. ' +
      "This is a deliberate stub (see this file's header): no level-selection " +
      'method has been approved and no real XAUUSD data is available yet. ' +
      'See src/research/first-touch/ for the engine and its test suite.',
  );
}

if (require.main === module) {
  main();
}
