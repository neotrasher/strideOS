import { ActivitySource, ActivitySport } from "@prisma/client";
import { NextResponse } from "next/server";

import type { RunningActivity, WeeklyTrendPoint, ZoneShare } from "@/lib/dashboard-data";
import { dashboardStats, trainingTargets, weeklyTrend as fallbackWeeklyTrend } from "@/lib/dashboard-data";
import { ensureDemoUser } from "@/lib/demo-user";
import { prisma } from "@/lib/prisma";

const SAMPLE_POINTS = 14;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toNumberArray = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
};

const trimText = (value: string | null | undefined, max = 220) => {
  if (!value) return null;
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3)}...`;
};

const sampleArray = (values: number[], points = SAMPLE_POINTS, fallbackValue = 0): number[] => {
  if (values.length === 0) return Array.from({ length: points }, () => fallbackValue);
  if (values.length === points) return values.map((value) => Math.round(value));

  return Array.from({ length: points }, (_, index) => {
    const position = (index / Math.max(1, points - 1)) * (values.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(values.length - 1, Math.ceil(position));
    const ratio = position - lower;
    const lowValue = values[lower] ?? fallbackValue;
    const highValue = values[upper] ?? lowValue;
    return Math.round(lowValue + (highValue - lowValue) * ratio);
  });
};

const smoothSeries = (values: number[], window = 3) => {
  if (values.length <= 2) return values;
  return values.map((_, index) => {
    const from = Math.max(0, index - Math.floor(window / 2));
    const to = Math.min(values.length - 1, index + Math.floor(window / 2));
    const slice = values.slice(from, to + 1);
    const avg = slice.reduce((sum, item) => sum + item, 0) / Math.max(1, slice.length);
    return Math.round(avg);
  });
};

const repeatSeries = (value: number, points: number) =>
  Array.from({ length: points }, () => Math.round(value));

const buildCumulativeElevationFromSplits = (splitElevationDiffs: number[]) => {
  if (splitElevationDiffs.length === 0) return [];
  const cumulative: number[] = [];
  let total = 0;
  for (const diff of splitElevationDiffs) {
    total += diff;
    cumulative.push(Math.round(total));
  }
  const min = Math.min(...cumulative);
  return cumulative.map((value) => value - min);
};

const secPerKmToPace = (secPerKm: number | null) => {
  if (!secPerKm || secPerKm <= 0) return "0:00 /km";
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${String(sec).padStart(2, "0")} /km`;
};

const mapWorkoutType = (sport: ActivitySport) => {
  if (sport === ActivitySport.TRAIL_RUN) return "Trail";
  if (sport === ActivitySport.TREADMILL) return "Treadmill";
  if (sport === ActivitySport.RUN) return "Run";
  return "Other";
};

const mapPlanTarget = (workoutType: string, distanceKm: number, pace: string) => {
  if (workoutType === "Trail") return `Rodaje trail controlado (${distanceKm.toFixed(1)} km).`;
  if (workoutType === "Treadmill") return `Sesion indoor estable a ritmo ${pace}.`;
  return `Completar ${distanceKm.toFixed(1)} km sosteniendo ritmo ${pace}.`;
};

const estimateTss = (movingTimeMin: number, avgHr: number) => {
  if (movingTimeMin <= 0) return 0;
  const hrFactor = avgHr > 0 ? avgHr / 150 : 1;
  return Math.max(10, Math.round(movingTimeMin * hrFactor));
};

const estimateRpe = (tss: number) => Math.min(10, Math.max(2, Math.round(tss / 12)));

const buildZoneDistribution = (hrSeries: number[], avgHr: number): ZoneShare[] => {
  const values = hrSeries.length > 0 ? hrSeries : [avgHr].filter((value) => value > 0);
  const fallback: ZoneShare[] = [
    { zone: "Z1", minutes: 0 },
    { zone: "Z2", minutes: 0 },
    { zone: "Z3", minutes: 0 },
    { zone: "Z4", minutes: 0 },
    { zone: "Z5", minutes: 0 },
  ];
  if (values.length === 0) return fallback;

  for (const hr of values) {
    if (hr < 130) fallback[0].minutes += 1;
    else if (hr < 145) fallback[1].minutes += 1;
    else if (hr < 160) fallback[2].minutes += 1;
    else if (hr < 173) fallback[3].minutes += 1;
    else fallback[4].minutes += 1;
  }
  return fallback;
};

const getIsoWeek = (date: Date) => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
};

const buildWeeklyTrend = (activities: RunningActivity[]): WeeklyTrendPoint[] => {
  const map = new Map<string, { distanceKm: number; load: number; paceSec: number; count: number }>();
  for (const activity of activities) {
    const key = getIsoWeek(new Date(activity.date));
    const current = map.get(key) ?? { distanceKm: 0, load: 0, paceSec: 0, count: 0 };
    const paceSec = Math.max(1, Math.round((activity.movingTimeMin * 60) / Math.max(0.1, activity.distanceKm)));
    current.distanceKm += activity.distanceKm;
    current.load += activity.tss;
    current.paceSec += paceSec;
    current.count += 1;
    map.set(key, current);
  }

  const points = Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([weekKey, value]) => ({
      week: weekKey.split("-")[1] ?? weekKey,
      distanceKm: Math.round(value.distanceKm * 10) / 10,
      load: Math.round(value.load),
      avgPaceSec: Math.round(value.paceSec / Math.max(1, value.count)),
    }));

  return points.length > 0 ? points : fallbackWeeklyTrend;
};

const buildStats = (activities: RunningActivity[]) => {
  if (activities.length === 0) return dashboardStats;

  const now = new Date();
  const currentWeek = getIsoWeek(now);
  const weekActivities = activities.filter((item) => getIsoWeek(new Date(item.date)) === currentWeek);
  const weekKm = weekActivities.reduce((sum, item) => sum + item.distanceKm, 0);
  const weekElevation = weekActivities.reduce((sum, item) => sum + item.elevationGainM, 0);
  const weekLoad = weekActivities.reduce((sum, item) => sum + item.tss, 0);
  const adherence = Math.min(100, Math.max(65, Math.round((weekActivities.length / 5) * 100)));

  return [
    { label: "Km semana", value: weekKm.toFixed(1), helper: `Objetivo ${Math.max(55, Math.round(weekKm + 4))} km` },
    { label: "Desnivel", value: `${Math.round(weekElevation)} m`, helper: "Calculado en actividades reales" },
    { label: "Carga", value: String(Math.round(weekLoad)), helper: "7 dias" },
    { label: "Adherencia", value: `${adherence}%`, helper: "Basado en sesiones semanales" },
  ];
};

const mapActivity = (activity: {
  id: string;
  source: ActivitySource;
  sport: ActivitySport;
  name: string;
  summary: string | null;
  startedAt: Date;
  distanceM: number | null;
  movingTimeS: number | null;
  elapsedTimeS: number | null;
  elevationGainM: number | null;
  averageHr: number | null;
  maxHr: number | null;
  averageCadence: number | null;
  averagePower: number | null;
  averagePaceSecondsKm: number | null;
  rpe: number | null;
  rawPayload: unknown;
}): RunningActivity => {
  const payload = isRecord(activity.rawPayload) ? activity.rawPayload : null;
  const detail = payload && isRecord(payload.detail) ? payload.detail : null;
  const streams = payload && isRecord(payload.streams) ? payload.streams : null;

  const distanceKm = (activity.distanceM ?? 0) / 1000;
  const movingTimeMin = Math.round((activity.movingTimeS ?? 0) / 60);
  const elapsedTimeMin = Math.round((activity.elapsedTimeS ?? activity.movingTimeS ?? 0) / 60);
  const avgHr = activity.averageHr ?? Math.round(toNumber(detail?.average_heartrate) ?? 0);
  const maxHr = activity.maxHr ?? Math.round(toNumber(detail?.max_heartrate) ?? 0);
  const avgPaceSec =
    activity.averagePaceSecondsKm ??
    ((activity.movingTimeS ?? 0) > 0 && distanceKm > 0 ? (activity.movingTimeS ?? 0) / distanceKm : null);
  const avgPace = secPerKmToPace(avgPaceSec ? Math.round(avgPaceSec) : null);
  const avgCadence = activity.averageCadence ?? toNumber(detail?.average_cadence) ?? 0;
  const avgPower = activity.averagePower ?? toNumber(detail?.average_watts) ?? 0;
  const tss = Math.round(toNumber(detail?.suffer_score) ?? estimateTss(movingTimeMin, avgHr));

  const splitRecords = Array.isArray(detail?.splits_metric)
    ? (detail.splits_metric as unknown[]).filter((item): item is JsonRecord => isRecord(item))
    : [];
  const splitPaceValues = splitRecords
    .map((item) => toNumber(item.average_speed))
    .map((speed) => (speed && speed > 0 ? Math.round(1000 / speed) : null))
    .filter((item): item is number => item !== null);
  const splitHrValues = splitRecords
    .map((item) => toNumber(item.average_heartrate))
    .filter((item): item is number => item !== null && item > 0);
  const splitElevationDiffValues = splitRecords
    .map((item) => toNumber(item.elevation_difference))
    .filter((item): item is number => item !== null);

  const hrStream = streams && isRecord(streams.heartrate) ? toNumberArray(streams.heartrate.data) : [];
  const paceStreamRaw = streams && isRecord(streams.velocity_smooth) ? toNumberArray(streams.velocity_smooth.data) : [];
  const elevationStream = streams && isRecord(streams.altitude) ? toNumberArray(streams.altitude.data) : [];
  const paceStream = paceStreamRaw
    .map((speed) => (speed > 0 ? 1000 / speed : 0))
    .filter((item) => Number.isFinite(item) && item > 0);

  const paceSeries =
    paceStream.length > 0
      ? smoothSeries(sampleArray(paceStream, SAMPLE_POINTS, avgPaceSec ? Math.round(avgPaceSec) : 300), 3)
      : splitPaceValues.length > 0
        ? smoothSeries(sampleArray(splitPaceValues, SAMPLE_POINTS, splitPaceValues[0]), 3)
        : repeatSeries(Math.round(avgPaceSec ?? 300), SAMPLE_POINTS);

  const hrSeries =
    hrStream.length > 0
      ? smoothSeries(sampleArray(hrStream, SAMPLE_POINTS, avgHr || 140), 3)
      : splitHrValues.length > 0
        ? smoothSeries(sampleArray(splitHrValues, SAMPLE_POINTS, splitHrValues[0]), 3)
        : repeatSeries(Math.round(avgHr || 140), SAMPLE_POINTS);

  const splitElevationProfile = buildCumulativeElevationFromSplits(splitElevationDiffValues);
  const elevationSeries =
    elevationStream.length > 0
      ? smoothSeries(sampleArray(elevationStream, SAMPLE_POINTS, Math.round(activity.elevationGainM ?? 0)), 3)
      : splitElevationProfile.length > 0
        ? smoothSeries(sampleArray(splitElevationProfile, SAMPLE_POINTS, splitElevationProfile[0]), 3)
        : repeatSeries(0, SAMPLE_POINTS);

  const workoutType = mapWorkoutType(activity.sport);
  const zoneDistribution = buildZoneDistribution(hrSeries, avgHr || 0);
  const description = typeof detail?.description === "string" ? detail.description : null;
  const estimatedSplitCount = Math.max(1, Math.min(24, Math.round(distanceKm)));

  return {
    id: activity.id,
    source: activity.source === ActivitySource.STRAVA ? "strava" : "garmin",
    title: activity.name,
    date: activity.startedAt.toISOString(),
    workoutType,
    planTarget: mapPlanTarget(workoutType, distanceKm, avgPace),
    notes: trimText(activity.summary) ?? trimText(description, 260) ?? "Sin notas adicionales.",
    distanceKm: Math.round(distanceKm * 10) / 10,
    movingTimeMin,
    elapsedTimeMin,
    elevationGainM: Math.round(activity.elevationGainM ?? 0),
    avgPace,
    avgHr: avgHr || 0,
    maxHr: maxHr || 0,
    cadence: Math.round(avgCadence),
    avgPower: Math.round(avgPower),
    tss,
    rpe: activity.rpe ?? estimateRpe(tss),
    splitsKm:
      splitPaceValues.length > 0
        ? splitPaceValues
        : sampleArray(paceSeries, estimatedSplitCount, paceSeries[0]),
    paceSeriesSecPerKm: paceSeries,
    hrSeries,
    elevationSeries,
    zoneDistribution,
  };
};

export async function GET() {
  const user = await ensureDemoUser();
  const dbActivities = await prisma.activity.findMany({
    where: {
      userId: user.id,
      source: { in: [ActivitySource.STRAVA, ActivitySource.GARMIN] },
      sport: { in: [ActivitySport.RUN, ActivitySport.TRAIL_RUN, ActivitySport.TREADMILL] },
    },
    orderBy: { startedAt: "desc" },
    take: 180,
  });

  const activities = dbActivities.map(mapActivity);
  const stats = buildStats(activities);
  const computedWeeklyTrend = buildWeeklyTrend(activities);

  return NextResponse.json({
    activities,
    stats,
    weeklyTrend: computedWeeklyTrend,
    trainingTargets,
    total: activities.length,
  });
}
