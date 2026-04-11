import { ActivitySource, ConnectionProvider } from "@prisma/client";
import { NextResponse } from "next/server";

import { ensureDemoUser } from "@/lib/demo-user";
import { prisma } from "@/lib/prisma";
import { runStravaSync } from "@/lib/strava-sync";

type SyncBody = {
  includeStreams?: boolean;
  maxPages?: number;
  maxRequests?: number;
};

const parseCursor = (cursor: string | null) => {
  if (!cursor) return null;
  try {
    return JSON.parse(cursor) as {
      retryAtUtc?: string;
      pausedByQuota?: boolean;
      quotaSnapshot?: unknown;
      newestImportedAt?: string;
    };
  } catch {
    return null;
  }
};

export async function GET() {
  const user = await ensureDemoUser();
  const latestRun = await prisma.syncRun.findFirst({
    where: {
      userId: user.id,
      provider: ConnectionProvider.STRAVA,
    },
    orderBy: { createdAt: "desc" },
  });
  const history = await prisma.activity.aggregate({
    where: {
      userId: user.id,
      source: ActivitySource.STRAVA,
    },
    _count: { id: true },
    _min: { startedAt: true },
    _max: { startedAt: true },
  });
  const cursorData = parseCursor(latestRun?.cursor ?? null);

  return NextResponse.json({
    latest: latestRun
      ? {
          status: latestRun.status,
          importedCount: latestRun.importedCount,
          startedAt: latestRun.startedAt?.toISOString() ?? null,
          finishedAt: latestRun.finishedAt?.toISOString() ?? null,
          error: latestRun.error,
          cursor: latestRun.cursor,
          retryAtUtc: cursorData?.retryAtUtc ?? null,
          pausedByQuota: Boolean(cursorData?.pausedByQuota),
          quotaSnapshot: cursorData?.quotaSnapshot ?? null,
        }
      : null,
    history: {
      totalActivities: history._count.id,
      oldestStartedAt: history._min.startedAt?.toISOString() ?? null,
      newestStartedAt: history._max.startedAt?.toISOString() ?? null,
    },
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as SyncBody;
  const user = await ensureDemoUser();

  try {
    const result = await runStravaSync(user.id, {
      mode: "incremental",
      includeStreams: body.includeStreams ?? false,
      maxPages: body.maxPages ?? 1,
      maxRequests: body.maxRequests ?? 30,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido en sync Strava.";
    return NextResponse.json({ status: "failed", error: message }, { status: 500 });
  }
}
