/**
 * The three latencies of one execution, from its four measured instants.
 *
 *   detection -> submission   OUR delay: scheduling, queueing, pre-send checks.
 *                             The part this application controls, and the one
 *                             the one-second execution pass exists to shrink.
 *   submission -> fill        the broker's and the network's. Not ours to
 *                             shorten, and reported so it is never mistaken
 *                             for ours.
 *   signal -> fill            the total the operator experiences.
 *
 * A one-second evaluation cadence bounds only the FIRST. Nothing here, and
 * nothing in the collector, claims a one-second fill.
 *
 * Each figure is null when either end is missing, rather than computed from a
 * substitute: a latency built from the wrong instant looks exactly as
 * trustworthy as a real one.
 */
export interface ExecutionTimeline {
  readonly detectedAt: Date | null;
  readonly executionEvaluatedAt: Date | null;
  readonly submittedAt: Date | null;
  readonly acknowledgedAt: Date | null;
}

export interface ExecutionLatency {
  readonly detectionToSubmissionMs: number | null;
  readonly submissionToFillMs: number | null;
  readonly signalToFillMs: number | null;
}

function between(from: Date | null, to: Date | null): number | null {
  if (!from || !to) return null;
  return to.getTime() - from.getTime();
}

export function executionLatency(t: ExecutionTimeline): ExecutionLatency {
  return {
    detectionToSubmissionMs: between(t.detectedAt, t.submittedAt),
    submissionToFillMs: between(t.submittedAt, t.acknowledgedAt),
    signalToFillMs: between(t.detectedAt, t.acknowledgedAt),
  };
}

function seconds(ms: number | null): string {
  return ms === null ? 'unknown' : `${(ms / 1000).toFixed(2)}s`;
}

/** One line for a log or a Telegram message. */
export function describeLatency(l: ExecutionLatency): string {
  return (
    `Latency: signal->submit ${seconds(l.detectionToSubmissionMs)} (ours), ` +
    `submit->fill ${seconds(l.submissionToFillMs)} (broker), total ${seconds(l.signalToFillMs)}`
  );
}
