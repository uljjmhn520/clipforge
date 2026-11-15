import type { Shot } from "@/lib/db/schema";

/**
 * 针对 Google Flow (ImageFX) / Midjourney / FLUX 生成结构化的 3x3 九宫格提示词
 */
export function exportExternalGridPrompt(
  shots: Shot[],
  productName: string,
  platform: "google-flow" | "midjourney" | "flux" = "google-flow"
): string {
  const cellLines = shots.slice(0, 9).map((s, idx) => {
    return `Cell ${idx + 1} (${s.type}): ${s.description}`;
  });

  if (platform === "midjourney") {
    return [
      `A 3x3 equal storyboard grid of 9 shots for e-commerce commercial video of ${productName}`,
      `Same person, same outfit, same room, same realistic cinematic lighting across all 9 cells`,
      ...cellLines,
      `photorealistic 8k, shot on 35mm lens, sharp focus, clean composition, NO text, NO watermarks, NO borders, thin white gutters between cells --ar 9:16 --v 6.1`
    ].join(", ");
  }

  // Google Flow / Imagen 3 风格
  return [
    `A high-resolution 3x3 storyboard contact sheet grid with aspect ratio 9:16 vertical, depicting a commercial video for "${productName}".`,
    `CRITICAL CONSISTENCY: All 9 cells feature the exact same human subject, wearing the exact same outfit, in the same room with consistent natural daylight direction. The product package and brand details remain identical in every frame.`,
    `Grid layout details:`,
    ...cellLines,
    `Visual style: Crisp 4K realistic mobile photography, natural skin texture, physical camera angles.`,
    `NEGATIVE CONSTRAINTS: Absolutely NO text, NO numbers, NO letters, NO subtitles, NO watermarks, NO icons on the image. Each cell must be a clean, uncropped photographic frame.`
  ].join("\n\n");
}
