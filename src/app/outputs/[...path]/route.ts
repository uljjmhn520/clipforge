import { NextRequest } from "next/server";
import { servePublicFile } from "@/lib/utils/static-serve";

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const resolvedParams = await params;
  return servePublicFile(req, "outputs", resolvedParams.path || []);
}
