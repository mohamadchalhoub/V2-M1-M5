"use server";

import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";

export interface VolumeUpdateState {
  error?: string;
  success?: boolean;
}

export async function setGoldVolume(_prev: VolumeUpdateState, formData: FormData): Promise<VolumeUpdateState> {
  const volumeLots = Number(formData.get("volumeLots"));
  if (!Number.isFinite(volumeLots) || volumeLots <= 0) return { error: "Volume must be a positive number." };

  try {
    const result = await api.setGoldVolume({ volumeLots, note: "dashboard change" });
    revalidatePath("/gold-demo");
    if (!result.ok) return { error: result.error ?? "Volume change rejected." };
    return { success: true };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "Could not reach the API." };
  }
}

export interface StopEntriesState {
  error?: string;
  success?: boolean;
}

export async function setGoldStopNewEntries(active: boolean, _prev: StopEntriesState, _formData: FormData): Promise<StopEntriesState> {
  try {
    await api.setGoldStopNewEntries(active);
    revalidatePath("/gold-demo");
    return { success: true };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "Could not reach the API." };
  }
}

export interface ClosePositionState {
  error?: string;
  success?: boolean;
  note?: string;
}

export async function requestGoldClosePosition(positionId: string, _prev: ClosePositionState, _formData: FormData): Promise<ClosePositionState> {
  try {
    const result = await api.requestGoldClosePosition(positionId);
    revalidatePath("/gold-demo");
    if (!result.ok) return { error: result.error ?? "Close request rejected." };
    return { success: true, note: result.note };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "Could not reach the API." };
  }
}
