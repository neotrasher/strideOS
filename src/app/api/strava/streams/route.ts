import { NextResponse } from "next/server";

import { ensureDemoUser } from "@/lib/demo-user";
import { enrichMissingStravaStreams } from "@/lib/strava-sync";

type StreamsBody = {
  maxActivities?: number;
  maxRequests?: number;
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as StreamsBody;
  const user = await ensureDemoUser();

  try {
    const result = await enrichMissingStravaStreams(user.id, {
      maxActivities: body.maxActivities ?? 30,
      maxRequests: body.maxRequests ?? 80,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error enriqueciendo streams de Strava.";
    return NextResponse.json({ status: "failed", error: message }, { status: 500 });
  }
}

