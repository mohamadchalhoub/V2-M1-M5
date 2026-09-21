"use server";

import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";

export interface UploadState {
  error?: string;
  success?: boolean;
}

export async function uploadXtbCsv(accountId: string, _prev: UploadState, formData: FormData): Promise<UploadState> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a CSV file to upload." };
  }

  const csvContent = await file.text();

  try {
    const batch = await api.importCsv({ accountId, fileName: file.name, csvContent });
    revalidatePath(`/imports/${accountId}`);
    if (batch.status === "FAILED") {
      return { error: batch.error ?? "Import failed — no rows could be parsed." };
    }
    return { success: true };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "Upload failed — could not reach the API." };
  }
}
