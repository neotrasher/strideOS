import { ActivitySource, ActivitySport, ConnectionProvider, SyncStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ensureValidStravaToken } from "@/lib/strava";

type StravaActivity = {
  id: number;
  name?: string;
  type?: string;
  start_date?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  total_elevation_gain?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  average_watts?: number;
  average_speed?: number;
};

type StravaActivityDetail = StravaActivity & {
  description?: string;
  suffer_score?: number;
  calories?: number;
  average_temp?: number;
  max_watts?: number;
  weighted_average_watts?: number;
  laps?: unknown[];
  splits_metric?: unknown[];
  best_efforts?: unknown[];
};

type StravaStreamItem = {
  type: string;
  data: number[] | string[];
};

export type StravaSyncMode = "incremental" | "backfill";

export type RunStravaSyncOptions = {
  mode?: StravaSyncMode;
  fromDate?: string | null;
  includeStreams?: boolean;
  maxPages?: number;
  maxRequests?: number;
};

export type RunStravaSyncResult = {
  status: "success" | "throttled";
  importedCount: number;
  updatedCount: number;
  requestsUsed: number;
  cursor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  quota: StravaQuotaSnapshot | null;
  retryAtUtc: string | null;
  message: string | null;
};

type QuotaWindow = {
  used: number;
  limit: number;
  remaining: number;
  resetAtUtc: string;
};

type StravaQuotaSnapshot = {
  capturedAtUtc: string;
  general: {
    quarterHour: QuotaWindow;
    daily: QuotaWindow;
  };
  read: {
    quarterHour: QuotaWindow;
    daily: QuotaWindow;
  };
};

type QuotaGuard = {
  shouldPause: boolean;
  reason: string | null;
  retryAtUtc: string | null;
};

class StravaQuotaError extends Error {
  quota: StravaQuotaSnapshot | null;
  retryAtUtc: string | null;

  constructor(quota: StravaQuotaSnapshot | null, message = "Se alcanzo el limite de Strava.") {
    super(message);
    this.name = "StravaQuotaError";
    this.quota = quota;
    this.retryAtUtc = quota ? resolveRetryAt(quota) : null;
  }
}

const SAFETY_MIN_GENERAL_15 = 10;
const SAFETY_MIN_READ_15 = 6;
const SAFETY_MIN_GENERAL_DAY = 60;
const SAFETY_MIN_READ_DAY = 30;

const mapSport = (type?: string): ActivitySport => {
  if (type === "Run") return ActivitySport.RUN;
  if (type === "TrailRun") return ActivitySport.TRAIL_RUN;
  if (type === "VirtualRun") return ActivitySport.TREADMILL;
  return ActivitySport.OTHER;
};

const paceSecondsPerKm = (averageSpeed?: number) => {
  if (!averageSpeed || averageSpeed <= 0) return null;
  return Math.round((1000 / averageSpeed) * 100) / 100;
};

const parseRatePair = (value: string | null): [number, number] | null => {
  if (!value) return null;
  const [leftRaw, rightRaw] = value.split(",", 2);
  const left = Number(leftRaw?.trim());
  const right = Number(rightRaw?.trim());
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return [left, right];
};

const nextQuarterHourIsoUtc = () => {
  const now = new Date();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  const minute = next.getUTCMinutes();
  next.setUTCMinutes(Math.floor(minute / 15) * 15 + 15);
  return next.toISOString();
};

const nextUtcMidnightIso = () => {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.toISOString();
};

const buildWindow = (used: number, limit: number, resetAtUtc: string): QuotaWindow => ({
  used,
  limit,
  remaining: Math.max(0, limit - used),
  resetAtUtc,
});

const parseQuotaHeaders = (headers: Headers): StravaQuotaSnapshot | null => {
  const generalLimit = parseRatePair(headers.get("x-ratelimit-limit"));
  const generalUsage = parseRatePair(headers.get("x-ratelimit-usage"));
  const readLimit = parseRatePair(headers.get("x-readratelimit-limit"));
  const readUsage = parseRatePair(headers.get("x-readratelimit-usage"));

  if (!generalLimit || !generalUsage || !readLimit || !readUsage) {
    return null;
  }

  const quarterReset = nextQuarterHourIsoUtc();
  const dailyReset = nextUtcMidnightIso();

  return {
    capturedAtUtc: new Date().toISOString(),
    general: {
      quarterHour: buildWindow(generalUsage[0], generalLimit[0], quarterReset),
      daily: buildWindow(generalUsage[1], generalLimit[1], dailyReset),
    },
    read: {
      quarterHour: buildWindow(readUsage[0], readLimit[0], quarterReset),
      daily: buildWindow(readUsage[1], readLimit[1], dailyReset),
    },
  };
};

const resolveRetryAt = (quota: StravaQuotaSnapshot) => {
  if (quota.general.quarterHour.remaining <= 0 || quota.read.quarterHour.remaining <= 0) {
    return quota.general.quarterHour.resetAtUtc;
  }
  if (quota.general.daily.remaining <= 0 || quota.read.daily.remaining <= 0) {
    return quota.general.daily.resetAtUtc;
  }
  return null;
};

const evaluateQuotaGuard = (quota: StravaQuotaSnapshot | null): QuotaGuard => {
  if (!quota) {
    return { shouldPause: false, reason: null, retryAtUtc: null };
  }

  if (quota.general.quarterHour.remaining <= SAFETY_MIN_GENERAL_15) {
    return {
      shouldPause: true,
      reason: "Quedan muy pocas requests generales en la ventana de 15 minutos.",
      retryAtUtc: quota.general.quarterHour.resetAtUtc,
    };
  }
  if (quota.read.quarterHour.remaining <= SAFETY_MIN_READ_15) {
    return {
      shouldPause: true,
      reason: "Quedan muy pocas requests de lectura en la ventana de 15 minutos.",
      retryAtUtc: quota.read.quarterHour.resetAtUtc,
    };
  }
  if (quota.general.daily.remaining <= SAFETY_MIN_GENERAL_DAY) {
    return {
      shouldPause: true,
      reason: "Quedan muy pocas requests generales en el limite diario.",
      retryAtUtc: quota.general.daily.resetAtUtc,
    };
  }
  if (quota.read.daily.remaining <= SAFETY_MIN_READ_DAY) {
    return {
      shouldPause: true,
      reason: "Quedan muy pocas requests de lectura en el limite diario.",
      retryAtUtc: quota.read.daily.resetAtUtc,
    };
  }
  return { shouldPause: false, reason: null, retryAtUtc: null };
};

const fetchActivitiesPage = async (accessToken: string, paramsInput: { page: number; after?: number; before?: number }) => {
  const params = new URLSearchParams({
    per_page: "100",
    page: String(paramsInput.page),
  });
  if (paramsInput.after) params.set("after", String(paramsInput.after));
  if (paramsInput.before) params.set("before", String(paramsInput.before));

  const response = await fetch(`https://www.strava.com/api/v3/athlete/activities?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const quota = parseQuotaHeaders(response.headers);

  if (response.status === 429) {
    throw new StravaQuotaError(quota);
  }

  if (!response.ok) {
    throw new Error("Error consultando actividades de Strava.");
  }

  return {
    data: (await response.json()) as StravaActivity[],
    quota,
  };
};

const fetchActivityDetail = async (accessToken: string, activityId: number) => {
  const response = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}?include_all_efforts=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );
  const quota = parseQuotaHeaders(response.headers);

  if (response.status === 429) {
    throw new StravaQuotaError(quota);
  }

  if (!response.ok) {
    throw new Error(`No se pudo obtener detalle de actividad ${activityId}.`);
  }
  return {
    data: (await response.json()) as StravaActivityDetail,
    quota,
  };
};

const fetchActivityStreams = async (accessToken: string, activityId: number) => {
  const keys = "time,distance,latlng,altitude,velocity_smooth,heartrate,cadence,watts,temp,moving,grade_smooth";
  const response = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=${keys}&key_by_type=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );
  const quota = parseQuotaHeaders(response.headers);

  if (response.status === 429) {
    throw new StravaQuotaError(quota);
  }
  if (!response.ok) {
    return { data: null, quota };
  }
  return {
    data: (await response.json()) as Record<string, StravaStreamItem>,
    quota,
  };
};

export const runStravaSync = async (userId: string, options?: RunStravaSyncOptions): Promise<RunStravaSyncResult> => {
  const mode = options?.mode ?? "incremental";
  const includeStreams = options?.includeStreams ?? false;
  const maxPagesDefault = mode === "incremental" ? 1 : 3;
  const maxPages = Math.max(1, Math.min(options?.maxPages ?? maxPagesDefault, 10));
  const maxRequestsDefault = mode === "incremental" ? 30 : 80;
  const maxRequests = Math.max(5, Math.min(options?.maxRequests ?? maxRequestsDefault, 180));

  const syncRun = await prisma.syncRun.create({
    data: {
      userId,
      provider: ConnectionProvider.STRAVA,
      status: SyncStatus.RUNNING,
      startedAt: new Date(),
      cursor: JSON.stringify({ mode }),
    },
  });

  try {
    const accessToken = await ensureValidStravaToken(userId);
    const latestStravaActivity = await prisma.activity.findFirst({
      where: { userId, source: ActivitySource.STRAVA },
      orderBy: { startedAt: "desc" },
    });

    const fromTimestamp = options?.fromDate ? Math.floor(new Date(options.fromDate).getTime() / 1000) : undefined;
    const afterTimestamp =
      mode === "incremental" && latestStravaActivity
        ? Math.floor(latestStravaActivity.startedAt.getTime() / 1000) - 1
        : mode === "incremental"
          ? fromTimestamp
          : undefined;

    let beforeTimestamp: number | undefined;
    if (mode === "backfill") {
      const lastBackfillRun = await prisma.syncRun.findFirst({
        where: {
          userId,
          provider: ConnectionProvider.STRAVA,
          status: SyncStatus.SUCCESS,
          cursor: { startsWith: "{\"mode\":\"backfill\"" },
        },
        orderBy: { createdAt: "desc" },
      });
      if (lastBackfillRun?.cursor) {
        try {
          const parsed = JSON.parse(lastBackfillRun.cursor) as { nextBefore?: number };
          if (parsed.nextBefore && Number.isFinite(parsed.nextBefore)) {
            beforeTimestamp = parsed.nextBefore;
          }
        } catch {
          beforeTimestamp = undefined;
        }
      }
      if (!beforeTimestamp) {
        beforeTimestamp = Math.floor(Date.now() / 1000) + 5;
      }
    }

    let page = 1;
    let requestsUsed = 0;
    let importedCount = 0;
    let updatedCount = 0;
    let keepGoing = true;
    let newestCursor: string | undefined;
    let oldestTimestampInRun: number | undefined;
    let latestQuota: StravaQuotaSnapshot | null = null;
    let haltedByQuota = false;
    let quotaStopReason: string | null = null;
    let retryAtUtc: string | null = null;

    while (keepGoing && page <= maxPages && requestsUsed < maxRequests) {
      let activities: StravaActivity[] = [];
      requestsUsed += 1;
      try {
        const pageResult = await fetchActivitiesPage(accessToken, {
          page,
          after: afterTimestamp,
          before: beforeTimestamp,
        });
        activities = pageResult.data;
        latestQuota = pageResult.quota ?? latestQuota;
      } catch (error) {
        if (error instanceof StravaQuotaError) {
          haltedByQuota = true;
          latestQuota = error.quota ?? latestQuota;
          quotaStopReason = error.message;
          retryAtUtc = error.retryAtUtc;
          break;
        }
        throw error;
      }

      const guardAfterPage = evaluateQuotaGuard(latestQuota);
      if (guardAfterPage.shouldPause) {
        haltedByQuota = true;
        quotaStopReason = guardAfterPage.reason;
        retryAtUtc = guardAfterPage.retryAtUtc;
      }
      if (activities.length === 0) break;

      for (const activity of activities) {
        if (!activity.id || !activity.start_date) continue;
        if (requestsUsed >= maxRequests || haltedByQuota) break;

        const startedAt = new Date(activity.start_date);
        const startedTimestamp = Math.floor(startedAt.getTime() / 1000);
        oldestTimestampInRun =
          oldestTimestampInRun === undefined
            ? startedTimestamp
            : Math.min(oldestTimestampInRun, startedTimestamp);

        if (mode === "backfill" && fromTimestamp && startedTimestamp < fromTimestamp) {
          keepGoing = false;
          continue;
        }

        newestCursor =
          !newestCursor || startedAt.toISOString() > newestCursor ? startedAt.toISOString() : newestCursor;

        const existing = await prisma.activity.findUnique({
          where: {
            source_externalId: {
              source: ActivitySource.STRAVA,
              externalId: String(activity.id),
            },
          },
          select: { id: true },
        });

        let detail: StravaActivityDetail | null = null;
        let streams: Record<string, StravaStreamItem> | null = null;

        if (requestsUsed < maxRequests) {
          try {
            requestsUsed += 1;
            const detailResult = await fetchActivityDetail(accessToken, activity.id);
            detail = detailResult.data;
            latestQuota = detailResult.quota ?? latestQuota;
          } catch (error) {
            if (error instanceof StravaQuotaError) {
              haltedByQuota = true;
              latestQuota = error.quota ?? latestQuota;
              quotaStopReason = error.message;
              retryAtUtc = error.retryAtUtc;
              break;
            }
            detail = null;
          }
        }

        const guardAfterDetail = evaluateQuotaGuard(latestQuota);
        if (guardAfterDetail.shouldPause) {
          haltedByQuota = true;
          quotaStopReason = guardAfterDetail.reason;
          retryAtUtc = guardAfterDetail.retryAtUtc;
        }

        if (includeStreams && requestsUsed < maxRequests && !haltedByQuota) {
          requestsUsed += 1;
          try {
            const streamsResult = await fetchActivityStreams(accessToken, activity.id);
            streams = streamsResult.data;
            latestQuota = streamsResult.quota ?? latestQuota;
          } catch (error) {
            if (error instanceof StravaQuotaError) {
              haltedByQuota = true;
              latestQuota = error.quota ?? latestQuota;
              quotaStopReason = error.message;
              retryAtUtc = error.retryAtUtc;
              break;
            }
            streams = null;
          }
        }

        const guardAfterStreams = evaluateQuotaGuard(latestQuota);
        if (guardAfterStreams.shouldPause) {
          haltedByQuota = true;
          quotaStopReason = guardAfterStreams.reason;
          retryAtUtc = guardAfterStreams.retryAtUtc;
        }

        const basePayload = detail ?? activity;
        const payload = {
          summary: activity,
          detail: basePayload,
          streams,
        };

        await prisma.activity.upsert({
          where: {
            source_externalId: {
              source: ActivitySource.STRAVA,
              externalId: String(activity.id),
            },
          },
          update: {
            sport: mapSport(basePayload.type),
            name: basePayload.name?.trim() || `Strava ${basePayload.type ?? "Activity"}`,
            startedAt,
            distanceM: basePayload.distance ?? null,
            movingTimeS: basePayload.moving_time ?? null,
            elapsedTimeS: basePayload.elapsed_time ?? null,
            elevationGainM: basePayload.total_elevation_gain ?? null,
            averageHr: basePayload.average_heartrate ? Math.round(basePayload.average_heartrate) : null,
            maxHr: basePayload.max_heartrate ? Math.round(basePayload.max_heartrate) : null,
            averageCadence: basePayload.average_cadence ?? null,
            averagePower: basePayload.average_watts ?? null,
            averagePaceSecondsKm: paceSecondsPerKm(basePayload.average_speed),
            rawPayload: payload,
          },
          create: {
            userId,
            source: ActivitySource.STRAVA,
            externalId: String(activity.id),
            sport: mapSport(basePayload.type),
            name: basePayload.name?.trim() || `Strava ${basePayload.type ?? "Activity"}`,
            startedAt,
            distanceM: basePayload.distance ?? null,
            movingTimeS: basePayload.moving_time ?? null,
            elapsedTimeS: basePayload.elapsed_time ?? null,
            elevationGainM: basePayload.total_elevation_gain ?? null,
            averageHr: basePayload.average_heartrate ? Math.round(basePayload.average_heartrate) : null,
            maxHr: basePayload.max_heartrate ? Math.round(basePayload.max_heartrate) : null,
            averageCadence: basePayload.average_cadence ?? null,
            averagePower: basePayload.average_watts ?? null,
            averagePaceSecondsKm: paceSecondsPerKm(basePayload.average_speed),
            rawPayload: payload,
          },
        });

        if (existing) updatedCount += 1;
        else importedCount += 1;
      }

      keepGoing = activities.length === 100 && requestsUsed < maxRequests && !haltedByQuota;
      page += 1;
    }

    const cursorPayload =
      mode === "backfill"
        ? {
            mode,
            nextBefore:
              oldestTimestampInRun && oldestTimestampInRun > 0 ? oldestTimestampInRun - 1 : undefined,
            newestImportedAt: newestCursor,
            quotaSnapshot: latestQuota,
            retryAtUtc: retryAtUtc,
            pausedByQuota: haltedByQuota,
          }
        : {
            mode,
            newestImportedAt: newestCursor,
            quotaSnapshot: latestQuota,
            retryAtUtc: retryAtUtc,
            pausedByQuota: haltedByQuota,
          };

    const finished = await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: SyncStatus.SUCCESS,
        finishedAt: new Date(),
        importedCount: importedCount + updatedCount,
        error: haltedByQuota ? (quotaStopReason ?? "Sync pausada por cuota de Strava.") : null,
        cursor: JSON.stringify(cursorPayload),
      },
    });

    return {
      status: haltedByQuota ? "throttled" : "success",
      importedCount,
      updatedCount,
      requestsUsed,
      cursor: finished.cursor,
      startedAt: finished.startedAt?.toISOString() ?? null,
      finishedAt: finished.finishedAt?.toISOString() ?? null,
      quota: latestQuota,
      retryAtUtc,
      message: haltedByQuota ? quotaStopReason ?? "Sync pausada por cuota de Strava." : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido en sync Strava.";
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: SyncStatus.FAILED,
        finishedAt: new Date(),
        error: message.slice(0, 500),
      },
    });
    throw error;
  }
};
