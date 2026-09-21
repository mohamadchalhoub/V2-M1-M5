"use server";

import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";

export interface ControlActionState {
  error?: string;
  success?: string;
}

/**
 * Freezes or resumes NEW ENTRIES only.
 *
 * Deliberately worded in the UI as entries-only: this control does not, and
 * must not, affect protective closures, reconciliation or the Friday
 * liquidation of owned positions. An operator who believed otherwise might
 * leave exposure open over a weekend.
 */
export async function setStopNewEntries(active: boolean): Promise<ControlActionState> {
  try {
    const result = await api.setXauusdRsiStopNewEntries(active);
    revalidatePath("/xauusd-rsi");
    if (result.warning) return { error: result.warning };
    return { success: result.note ?? "Done." };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Request failed." };
  }
}

/**
 * Sets the order volume.
 *
 * The backend validates against live broker min/max/step and REFUSES a value
 * that does not fit rather than rounding it, so the refusal reason is shown
 * verbatim here — silently trading a different size than was asked for would
 * be worse than the error.
 */
export async function setVolume(_prev: ControlActionState, formData: FormData): Promise<ControlActionState> {
  const raw = String(formData.get("volumeLots") ?? "").trim();
  const volumeLots = Number(raw);
  if (!raw || !Number.isFinite(volumeLots) || volumeLots <= 0) {
    return { error: `"${raw}" is not a positive number.` };
  }
  try {
    const result = await api.setXauusdRsiVolume(volumeLots, String(formData.get("note") ?? "") || undefined);
    revalidatePath("/xauusd-rsi");
    if (!result.ok) return { error: result.reason ?? "The backend refused this volume." };
    return { success: `Volume set to ${result.volumeLots} lots.` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Request failed." };
  }
}
