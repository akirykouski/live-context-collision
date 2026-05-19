import { getJobSnapshot } from "@/lib/runtime-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const snapshot = await getJobSnapshot(id);
  if (!snapshot) {
    return NextResponse.json(
      {
        id,
        status: "queued",
        actionIds: [],
      },
      { status: 200 },
    );
  }
  return NextResponse.json(snapshot);
}
