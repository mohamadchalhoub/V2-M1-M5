/**
 * Order volume for this strategy (§7).
 *
 * §7 says two things that pull in opposite directions unless they are
 * implemented carefully: the default is 0.5 lot, and an explicit configured
 * volume must be supported "with an audit trail" and must NOT be an
 * unrelated production setting inherited blindly.
 *
 * So resolution is explicit about PROVENANCE, not just about the number. The
 * result always records where the value came from, which is what makes the
 * audit trail real rather than a log line someone remembered to write. A
 * value inherited from an unrelated strategy's setting is not accepted at
 * all: it is reported as rejected and the clean-installation default is used
 * instead.
 *
 * Nothing here ever resizes a volume to make an order acceptable. §7 is
 * explicit — "Never silently resize volume or widen protection to force
 * acceptance" — so a volume that fails broker validation produces a refusal
 * with a reason, never a quietly smaller order.
 */
import { V2_DEFAULT_VOLUME_LOTS } from './safety-constants';
import { XAUUSD_M1M5_STRATEGY_VERSION } from './spec';

export type VolumeSource =
  /** No explicit setting exists; the clean-installation default applies. */
  | 'V2_DEFAULT'
  /** An explicit, validated setting belonging to THIS strategy. */
  | 'V2_EXPLICIT_SETTING'
  /** An explicit setting was present but unusable; the default applies. */
  | 'V2_DEFAULT_AFTER_REJECTION';

export interface ResolvedVolume {
  readonly lots: number;
  readonly source: VolumeSource;
  /** Audit line recording how this number was arrived at. */
  readonly provenance: string;
  /** Present when a configured value was refused, saying why. */
  readonly rejectedValue: string | null;
  readonly rejectionReason: string | null;
}

/**
 * Resolves the configured volume for this strategy.
 *
 * `configured` is this strategy's OWN setting — never another strategy's.
 * Callers must not pass a value read from `GOLD_*`, `TREND_BREAKOUT_*` or the
 * previous RSI strategy's settings; those belong to applications with
 * different risk profiles and, in this project, to a system that is still
 * running on a different account.
 */
export function resolveVolume(configured: string | number | null | undefined): ResolvedVolume {
  if (configured === null || configured === undefined || `${configured}`.trim() === '') {
    return {
      lots: V2_DEFAULT_VOLUME_LOTS,
      source: 'V2_DEFAULT',
      provenance:
        `No explicit volume configured for ${XAUUSD_M1M5_STRATEGY_VERSION}; using the clean-installation ` +
        `default of ${V2_DEFAULT_VOLUME_LOTS} lot.`,
      rejectedValue: null,
      rejectionReason: null,
    };
  }

  const raw = `${configured}`.trim();
  const parsed = Number(raw);
  const reject = (reason: string): ResolvedVolume => ({
    lots: V2_DEFAULT_VOLUME_LOTS,
    source: 'V2_DEFAULT_AFTER_REJECTION',
    provenance:
      `Configured volume ${JSON.stringify(raw)} was refused (${reason}); using the clean-installation ` +
      `default of ${V2_DEFAULT_VOLUME_LOTS} lot instead. The configured value was NOT adjusted to make it usable.`,
    rejectedValue: raw,
    rejectionReason: reason,
  });

  if (!Number.isFinite(parsed)) return reject('not a number');
  if (parsed <= 0) return reject('not positive');

  return {
    lots: parsed,
    source: 'V2_EXPLICIT_SETTING',
    provenance:
      `Explicit ${XAUUSD_M1M5_STRATEGY_VERSION} volume setting of ${parsed} lot. Validated against live ` +
      'broker min/max/step before every submission.',
    rejectedValue: null,
    rejectionReason: null,
  };
}

/** Broker contract limits, queried live rather than assumed (§7). */
export interface BrokerVolumeLimits {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export interface VolumeValidation {
  readonly acceptable: boolean;
  readonly reason: string | null;
}

/**
 * Validates a volume against the broker's real contract limits.
 *
 * Returns a verdict rather than a corrected number, deliberately. Rounding a
 * volume to the nearest valid step would be exactly the silent resize §7
 * forbids: the operator configured a size, and if the broker cannot accept it
 * they need to know, not to discover later that the strategy has been trading
 * something else.
 */
export function validateVolume(lots: number, limits: BrokerVolumeLimits): VolumeValidation {
  if (!Number.isFinite(lots) || lots <= 0) {
    return { acceptable: false, reason: `Volume ${lots} is not a positive number.` };
  }
  if (lots < limits.min) {
    return { acceptable: false, reason: `Volume ${lots} is below the broker minimum of ${limits.min}.` };
  }
  if (lots > limits.max) {
    return { acceptable: false, reason: `Volume ${lots} is above the broker maximum of ${limits.max}.` };
  }
  if (limits.step > 0) {
    // Floating point: 0.5 / 0.01 is 49.999999999999993, so a direct modulo
    // test rejects perfectly valid volumes. Compare against the nearest step
    // multiple with a tolerance far tighter than any real broker step.
    const steps = lots / limits.step;
    const nearest = Math.round(steps);
    if (Math.abs(steps - nearest) > 1e-6) {
      return {
        acceptable: false,
        reason:
          `Volume ${lots} is not a multiple of the broker volume step ${limits.step}. ` +
          'It is reported rather than rounded: silently resizing would trade a size nobody configured.',
      };
    }
  }
  return { acceptable: true, reason: null };
}
