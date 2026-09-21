"use server";

import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";

export interface VolumeUpdateState {
  error?: string;
  warning?: string;
  success?: boolean;
}

// §2/§12 — "Only the authenticated user can change these volumes... Before
// saving volume changes, validate the values and explain that they apply to
// future trades only." `changedBy` is the operator's own identifying string
// (this dashboard has one shared bearer token, not per-user login sessions —
// see trend-breakout.controller.ts's own comment on this) — required, not
// inferred, so the audit trail always has a real name attached.
export async function updateTrendBreakoutVolume(
  accountId: string,
  instrument: string,
  _prev: VolumeUpdateState,
  formData: FormData,
): Promise<VolumeUpdateState> {
  const volumeLots = Number(formData.get("volumeLots"));
  const changedBy = String(formData.get("changedBy") ?? "").trim();

  if (!changedBy) return { error: "Enter your name/email to attribute this change." };
  if (!Number.isFinite(volumeLots) || volumeLots <= 0) return { error: "Volume must be a positive number." };

  try {
    const result = await api.updateTrendBreakoutVolume(accountId, instrument, { volumeLots, changedBy });
    revalidatePath(`/trend-breakout/${accountId}`);
    if (!result.ok) return { error: result.error ?? "Volume update rejected." };
    return { success: true, warning: result.warning };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "Could not reach the API." };
  }
}

export interface DrawdownResetState {
  error?: string;
  success?: boolean;
}

export async function resetTrendBreakoutDrawdown(accountId: string, _prev: DrawdownResetState, formData: FormData): Promise<DrawdownResetState> {
  const resetBy = String(formData.get("resetBy") ?? "").trim();
  if (!resetBy) return { error: "Enter your name/email to attribute this reset." };
  try {
    await api.resetTrendBreakoutDrawdown(accountId, resetBy);
    revalidatePath(`/trend-breakout/${accountId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "Could not reach the API." };
  }
}
