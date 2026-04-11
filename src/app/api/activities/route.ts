import { NextResponse } from "next/server";

import { dashboardStats, runningActivities, trainingTargets, weeklyTrend } from "@/lib/dashboard-data";

export async function GET() {
  return NextResponse.json({
    activities: runningActivities,
    stats: dashboardStats,
    weeklyTrend,
    trainingTargets,
    total: runningActivities.length,
  });
}
