import { NextResponse } from "next/server";

import { ensureDemoUser } from "@/lib/demo-user";
import { runStravaSync } from "@/lib/strava-sync";

type BackfillBody = {
  fromDate?: string;
  includeStreams?: boolean;
  maxPages?: number;
  maxRequests?: number;
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as BackfillBody;
  const user = await ensureDemoUser();
  const normalizedFromDate = body.fromDate?.trim() ? body.fromDate.trim() : undefined;

  try {
    const result = await runStravaSync(user.id, {
      mode: "backfill",
      fromDate: normalizedFromDate,
      includeStreams: body.includeStreams ?? false,
      maxPages: body.maxPages ?? 3,
      maxRequests: body.maxRequests ?? 70,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido en backfill Strava.";
    return NextResponse.json({ status: "failed", error: message }, { status: 500 });
  }
}
