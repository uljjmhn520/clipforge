import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scripts, compositions } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  try {
    const list = await db.query.projects.findMany({
      orderBy: [desc(projects.createdAt)],
    });

    return NextResponse.json({ projects: list });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
