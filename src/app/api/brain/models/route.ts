import { NextResponse } from "next/server";
import { listAvailableGeminiModels, getDefaultGeminiModel } from "@/lib/modules/brain/gemini-client";

export async function GET() {
  try {
    const models = await listAvailableGeminiModels();
    return NextResponse.json({
      models,
      defaultModel: getDefaultGeminiModel(),
    });
  } catch (error: any) {
    return NextResponse.json({
      models: ["gemini-3.8-flash", "gemini-3.8-pro", "gemini-2.0-flash"],
      defaultModel: "gemini-3.8-flash",
      warning: error.message,
    });
  }
}
