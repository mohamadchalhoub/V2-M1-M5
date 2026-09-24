"use server";

import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";

export interface VolumeUpdateState {
  error?: string;
  success?: boolean;
}

export async function setSarVolume(_prev: VolumeUpdateState, formData: FormData): Promise<VolumeUpdateState> {
  const volumeLots = Number(formData.get("volumeLots"));
  if (!Number.isFinite(volumeLots) || volumeLots <= 0) return { error: "Volume must be a positive number." };

  try {
    const result = await api.setXauusdSarVolume({ volumeLots, note: "dashboard change" });
    revalidatePath("/xauusd-sar");
    if (!result.ok) return { error: result.error ?? "Volume change rejected." };
    return { success: true };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "Could not reach the API." };
  }
}
