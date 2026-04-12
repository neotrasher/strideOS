"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type MouseEvent } from "react";

import {
  dashboardStats as fallbackDashboardStats,
  runningActivities as fallbackActivities,
  trainingTargets as fallbackTrainingTargets,
  weeklyTrend as fallbackWeeklyTrend,
} from "@/lib/dashboard-data";
import type { RunningActivity, WeeklyTrendPoint } from "@/lib/dashboard-data";

type AnalyzeResponse = {
  summary: string;
  insights: string[];
  recommendation: string;
  score: number;
  source: "openai" | "fallback";
  model?: string;
};

type GoalType = "weekly-km" | "weekly-load" | "10k-time";
type GoalStatus = "active" | "completed" | "paused";

type Goal = {
  id: string;
  title: string;
  type: GoalType;
  status: GoalStatus;
  target: number;
  dueDate: string;
  raceName?: string | null;
  raceDistanceKm?: number | null;
};

type RacePredict = {
  label: string;
  distanceKm: number;
  predictedSeconds: number;
};

type GoalDraft = {
  title: string;
  type: GoalType;
  target: string;
  dueDate: string;
  raceName: string;
  raceDistanceKm: string;
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

type SyncApiResult = {
  status?: "success" | "throttled";
  importedCount?: number;
  updatedCount?: number;
  requestsUsed?: number;
  error?: string;
  retryAtUtc?: string | null;
  message?: string | null;
  quota?: StravaQuotaSnapshot | null;
};

type StatCard = {
  label: string;
  value: string;
  helper: string;
};

type TrainingTarget = {
  label: string;
  value: string;
};

type ActivitiesApiResponse = {
  activities?: RunningActivity[];
  stats?: StatCard[];
  weeklyTrend?: WeeklyTrendPoint[];
  trainingTargets?: TrainingTarget[];
};

type SessionMetricKey = "pace" | "hr" | "elevation";

const sourceLabel = {
  strava: "Strava",
  garmin: "Garmin",
} as const;

const goalTypeLabel: Record<GoalType, string> = {
  "weekly-km": "Km semana",
  "weekly-load": "Carga semanal",
  "10k-time": "Tiempo 10K",
};

const initialGoals: Goal[] = [
  {
    id: "fallback-1",
    title: "Subir volumen base",
    type: "weekly-km",
    status: "active",
    target: 70,
    dueDate: "2026-05-15",
    raceName: null,
    raceDistanceKm: null,
  },
];

const toMinutes = (seconds: number) => Math.round((seconds / 60) * 10) / 10;

const formatDate = (isoDate: string) =>
  new Intl.DateTimeFormat("es-CO", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoDate));

const formatDateShort = (isoDate: string) =>
  new Intl.DateTimeFormat("es-CO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoDate));

const formatRetryAt = (isoDate: string | null | undefined) => {
  if (!isoDate) return null;
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("es-CO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
};

const formatPaceFromSeconds = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
};

const getWeekKey = (isoDate: string) => {
  const date = new Date(isoDate);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

const getWeekLabel = (weekKey: string) => {
  const [yearRaw, weekRaw] = weekKey.split("-W");
  const year = Number(yearRaw);
  const week = Number(weekRaw);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return weekKey;
  return `Semana ${week} · ${year}`;
};

const resolveBarHeight = (value: number, max: number) => {
  if (max <= 0) return "8%";
  return `${Math.max(8, Math.round((value / max) * 100))}%`;
};

const paceToSeconds = (pace: string) => {
  const [minutes, seconds] = pace.split(" ")[0].split(":").map(Number);
  return minutes * 60 + seconds;
};

const formatRaceTime = (totalSeconds: number) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const riegelTime = (baseDistanceKm: number, baseSeconds: number, targetDistanceKm: number, exponent = 1.06) => {
  if (baseDistanceKm <= 0 || baseSeconds <= 0 || targetDistanceKm <= 0) return 0;
  return baseSeconds * Math.pow(targetDistanceKm / baseDistanceKm, exponent);
};

const formatGoalTarget = (goal: Goal) => {
  if (goal.type === "10k-time") return formatRaceTime(goal.target);
  return String(goal.target);
};

const statusLabel: Record<GoalStatus, string> = {
  active: "Activo",
  completed: "Completado",
  paused: "Pausado",
};

export function RunningDashboard() {
  const [activities, setActivities] = useState<RunningActivity[]>(fallbackActivities);
  const [stats, setStats] = useState<StatCard[]>(fallbackDashboardStats);
  const [trend, setTrend] = useState<WeeklyTrendPoint[]>(fallbackWeeklyTrend);
  const [targets, setTargets] = useState<TrainingTarget[]>(fallbackTrainingTargets);
  const [activitiesLoading, setActivitiesLoading] = useState(false);
  const [activitiesError, setActivitiesError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>(fallbackActivities[0]?.id ?? "");
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(true);
  const [goalsError, setGoalsError] = useState<string | null>(null);
  const [goalSaving, setGoalSaving] = useState(false);
  const [goalDeletingId, setGoalDeletingId] = useState<string | null>(null);
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<GoalDraft | null>(null);
  const [stravaConnected, setStravaConnected] = useState(false);
  const [stravaExpiresAt, setStravaExpiresAt] = useState<string | null>(null);
  const [stravaSyncing, setStravaSyncing] = useState(false);
  const [stravaBackfilling, setStravaBackfilling] = useState(false);
  const [stravaSyncMessage, setStravaSyncMessage] = useState<string>("");
  const [stravaHistoryMessage, setStravaHistoryMessage] = useState<string>("");
  const [stravaQuotaMessage, setStravaQuotaMessage] = useState<string>("");
  const [backfillFromDate, setBackfillFromDate] = useState("");
  const [weekCursor, setWeekCursor] = useState(0);
  const [sessionMetric, setSessionMetric] = useState<SessionMetricKey>("pace");
  const [hoveredKm, setHoveredKm] = useState<number | null>(null);
  const chartRef = useRef<SVGSVGElement | null>(null);

  const [goalTitle, setGoalTitle] = useState("");
  const [goalType, setGoalType] = useState<GoalType>("weekly-km");
  const [goalTarget, setGoalTarget] = useState("70");
  const [goalDate, setGoalDate] = useState("2026-06-15");
  const [raceName, setRaceName] = useState("");
  const [raceDistanceKm, setRaceDistanceKm] = useState("");

  const activityWeeks = useMemo(() => {
    const grouped = new Map<string, RunningActivity[]>();
    for (const activity of activities) {
      const key = getWeekKey(activity.date);
      const current = grouped.get(key) ?? [];
      current.push(activity);
      grouped.set(key, current);
    }
    return Array.from(grouped.entries())
      .map(([key, items]) => ({
        key,
        label: getWeekLabel(key),
        items: items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
      }))
      .sort((a, b) => b.key.localeCompare(a.key));
  }, [activities]);

  const safeWeekCursor = Math.min(Math.max(weekCursor, 0), Math.max(0, activityWeeks.length - 1));
  const visibleActivities =
    activityWeeks[safeWeekCursor]?.items ??
    activities;

  const selectedActivity = useMemo(() => {
    return visibleActivities.find((item) => item.id === selectedId) ?? visibleActivities[0] ?? activities[0] ?? fallbackActivities[0];
  }, [activities, selectedId, visibleActivities]);

  const updateQuotaMessage = (quota?: StravaQuotaSnapshot | null) => {
    if (!quota) {
      setStravaQuotaMessage("");
      return;
    }
    setStravaQuotaMessage(
      `Cuota: 15m gen ${quota.general.quarterHour.used}/${quota.general.quarterHour.limit} · lec ${quota.read.quarterHour.used}/${quota.read.quarterHour.limit} | dia gen ${quota.general.daily.used}/${quota.general.daily.limit} · lec ${quota.read.daily.used}/${quota.read.daily.limit}`,
    );
  };

  const refreshStravaOverview = async () => {
    try {
      const response = await fetch("/api/strava/sync");
      if (!response.ok) return;
      const payload = (await response.json()) as {
        latest?: { quotaSnapshot?: StravaQuotaSnapshot | null } | null;
        history?: {
          totalActivities?: number;
          oldestStartedAt?: string | null;
          newestStartedAt?: string | null;
        } | null;
      };

      if (payload.history?.totalActivities && payload.history.totalActivities > 0) {
        const oldest = payload.history.oldestStartedAt ? formatDateShort(payload.history.oldestStartedAt) : "?";
        const newest = payload.history.newestStartedAt ? formatDateShort(payload.history.newestStartedAt) : "?";
        setStravaHistoryMessage(`Historial: ${payload.history.totalActivities} actividades (${oldest} a ${newest})`);
      } else {
        setStravaHistoryMessage("Aun no hay historial sincronizado.");
      }
      updateQuotaMessage(payload.latest?.quotaSnapshot ?? null);
    } catch {
      // no-op
    }
  };

  useEffect(() => {
    setAnalysis(null);
    setError(null);
    setHoveredKm(null);
  }, [selectedId]);

  useEffect(() => {
    setHoveredKm(null);
  }, [sessionMetric]);

  useEffect(() => {
    setWeekCursor(0);
  }, [activities.length]);

  useEffect(() => {
    if (visibleActivities.length === 0) return;
    if (!visibleActivities.some((item) => item.id === selectedId)) {
      setSelectedId(visibleActivities[0].id);
    }
  }, [selectedId, visibleActivities]);

  useEffect(() => {
    let mounted = true;
    const loadActivities = async () => {
      setActivitiesLoading(true);
      setActivitiesError(null);
      try {
        const response = await fetch("/api/activities");
        if (!response.ok) throw new Error("No se pudieron cargar actividades reales.");
        const payload = (await response.json()) as ActivitiesApiResponse;
        if (!mounted) return;

        const nextActivities =
          Array.isArray(payload.activities) && payload.activities.length > 0
            ? payload.activities
            : fallbackActivities;
        setActivities(nextActivities);
        setStats(
          Array.isArray(payload.stats) && payload.stats.length > 0 ? payload.stats : fallbackDashboardStats,
        );
        setTrend(
          Array.isArray(payload.weeklyTrend) && payload.weeklyTrend.length > 0
            ? payload.weeklyTrend
            : fallbackWeeklyTrend,
        );
        setTargets(
          Array.isArray(payload.trainingTargets) && payload.trainingTargets.length > 0
            ? payload.trainingTargets
            : fallbackTrainingTargets,
        );

        setSelectedId((current) =>
          nextActivities.some((item) => item.id === current) ? current : (nextActivities[0]?.id ?? ""),
        );
      } catch (loadError) {
        if (!mounted) return;
        setActivitiesError(loadError instanceof Error ? loadError.message : "Error al cargar actividades.");
      } finally {
        if (mounted) setActivitiesLoading(false);
      }
    };

    loadActivities();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadStravaStatus = async () => {
      try {
        const response = await fetch("/api/strava/status");
        if (!response.ok) return;
        const payload = (await response.json()) as { connected?: boolean; expiresAt?: string | null };
        if (!mounted) return;
        setStravaConnected(Boolean(payload.connected));
        setStravaExpiresAt(payload.expiresAt ?? null);
      } catch {
        if (!mounted) return;
        setStravaConnected(false);
      }
    };
    loadStravaStatus();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadSyncStatus = async () => {
      try {
        const response = await fetch("/api/strava/sync");
        if (!response.ok) return;
        const payload = (await response.json()) as {
          latest?: {
            status?: string;
            importedCount?: number;
            finishedAt?: string | null;
            error?: string | null;
            retryAtUtc?: string | null;
            quotaSnapshot?: StravaQuotaSnapshot | null;
          } | null;
          history?: {
            totalActivities?: number;
            oldestStartedAt?: string | null;
            newestStartedAt?: string | null;
          } | null;
        };
        if (!mounted) return;

        if (payload.latest?.status === "SUCCESS") {
          setStravaSyncMessage(
            `Ultima sync OK: ${payload.latest.importedCount ?? 0} actividades` +
              (payload.latest.finishedAt ? ` (${payload.latest.finishedAt.slice(0, 19).replace("T", " ")})` : ""),
          );
        } else if (payload.latest?.status === "FAILED") {
          setStravaSyncMessage(`Ultima sync fallo: ${payload.latest.error ?? "sin detalle"}`);
        }

        if (payload.latest?.error && payload.latest.retryAtUtc) {
          const retryAt = formatRetryAt(payload.latest.retryAtUtc);
          if (retryAt) {
            setStravaSyncMessage(`${payload.latest.error} Reintenta desde ${retryAt}.`);
          }
        }

        await refreshStravaOverview();
      } catch {
        // ignore non-critical sync status load errors
      }
    };
    loadSyncStatus();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadGoals = async () => {
      setGoalsLoading(true);
      setGoalsError(null);
      try {
        const response = await fetch("/api/goals");
        if (!response.ok) {
          throw new Error("No se pudieron cargar los objetivos.");
        }
        const payload = (await response.json()) as { items?: Goal[] };
        if (!isMounted) return;
        setGoals(Array.isArray(payload.items) ? payload.items : []);
      } catch (loadError) {
        if (!isMounted) return;
        setGoals(initialGoals);
        setGoalsError(loadError instanceof Error ? loadError.message : "Error al cargar objetivos.");
      } finally {
        if (isMounted) setGoalsLoading(false);
      }
    };

    loadGoals();
    return () => {
      isMounted = false;
    };
  }, []);

  const maxDistance = Math.max(...trend.map((item) => item.distanceKm));
  const maxLoad = Math.max(...trend.map((item) => item.load));
  const latestWeek = trend[trend.length - 1];
  const paceSec = paceToSeconds(selectedActivity.avgPace);
  const paceFactor = Math.max(0.92, Math.min(1.08, 1 + (selectedActivity.tss - 70) / 600));

  const recentRunActivities = useMemo(
    () =>
      activities
        .filter((activity) => activity.distanceKm >= 3 && activity.movingTimeMin >= 15)
        .slice(0, 12),
    [activities],
  );

  const baselinePerformance = useMemo(() => {
    if (recentRunActivities.length === 0) {
      const baseDistance = Math.max(5, selectedActivity.distanceKm);
      const baseSeconds = paceSec * baseDistance;
      return { baseDistanceKm: baseDistance, baseSeconds, volatility: 0.12 };
    }

    const weighted = recentRunActivities.map((activity, index) => {
      const recencyWeight = 1 - index * 0.06;
      const distanceWeight = clamp(activity.distanceKm / 12, 0.45, 1.35);
      const weight = clamp(recencyWeight * distanceWeight, 0.2, 1.5);
      return {
        weight,
        distanceKm: activity.distanceKm,
        seconds: activity.movingTimeMin * 60,
      };
    });

    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0) || 1;
    const eq10kSeconds = weighted.reduce((sum, item) => {
      const eq = riegelTime(item.distanceKm, item.seconds, 10, 1.06);
      return sum + eq * item.weight;
    }, 0) / totalWeight;

    const avgEq = eq10kSeconds;
    const variance =
      weighted.reduce((sum, item) => {
        const eq = riegelTime(item.distanceKm, item.seconds, 10, 1.06);
        return sum + item.weight * Math.pow(eq - avgEq, 2);
      }, 0) / totalWeight;
    const volatility = Math.sqrt(Math.max(0, variance)) / Math.max(1, avgEq);

    return {
      baseDistanceKm: 10,
      baseSeconds: avgEq,
      volatility,
    };
  }, [paceSec, recentRunActivities, selectedActivity.distanceKm]);

  const predictions: RacePredict[] = useMemo(() => {
    const distances = [
      { label: "5K", distanceKm: 5 },
      { label: "10K", distanceKm: 10 },
      { label: "21K", distanceKm: 21.097 },
      { label: "42K", distanceKm: 42.195 },
    ];

    return distances.map((item) => ({
      label: item.label,
      distanceKm: item.distanceKm,
      predictedSeconds: Math.round(
        riegelTime(
          baselinePerformance.baseDistanceKm,
          baselinePerformance.baseSeconds,
          item.distanceKm,
          1.06,
        ),
      ),
    }));
  }, [baselinePerformance.baseDistanceKm, baselinePerformance.baseSeconds]);

  const confidence = clamp(
    Math.round(
      92 -
        baselinePerformance.volatility * 140 -
        Math.max(0, 8 - recentRunActivities.length) * 2.8,
    ),
    58,
    92,
  );

  const paceSplits = selectedActivity.splitsKm.length > 0 ? selectedActivity.splitsKm : selectedActivity.paceSeriesSecPerKm;
  const hrSplits = (selectedActivity.splitHr && selectedActivity.splitHr.length > 0) ? selectedActivity.splitHr : selectedActivity.hrSeries;
  const elevationSplits =
    (selectedActivity.splitElevation && selectedActivity.splitElevation.length > 0)
      ? selectedActivity.splitElevation
      : selectedActivity.elevationSeries;
  const streamDistance = selectedActivity.streamDistanceKm ?? [];
  const streamPace = selectedActivity.streamPaceSecPerKm ?? [];
  const streamHr = selectedActivity.streamHr ?? [];
  const streamElevation = selectedActivity.streamElevationM ?? [];
  const useStreamAxis =
    selectedActivity.chartAxis === "distance" &&
    streamDistance.length > 20 &&
    ((sessionMetric === "pace" && streamPace.length === streamDistance.length) ||
      (sessionMetric === "hr" && streamHr.length === streamDistance.length) ||
      (sessionMetric === "elevation" && streamElevation.length === streamDistance.length));

  const sessionSeries = useMemo(() => {
    if (useStreamAxis) {
      if (sessionMetric === "pace") return streamPace;
      if (sessionMetric === "hr") return streamHr;
      return streamElevation;
    }
    if (sessionMetric === "pace") return paceSplits;
    if (sessionMetric === "hr") return hrSplits;
    return elevationSplits;
  }, [elevationSplits, hrSplits, paceSplits, sessionMetric, streamElevation, streamHr, streamPace, useStreamAxis]);

  const sessionMetricMeta = useMemo(() => {
    if (sessionMetric === "pace") {
      return {
        title: "Ritmo por km",
        colorClass: "session-line-pace",
        yLabel: "min/km",
        invertScale: true,
        summary: `Promedio ${selectedActivity.avgPace}`,
        formatValue: (value: number) => `${formatPaceFromSeconds(value)} min/km`,
      };
    }
    if (sessionMetric === "hr") {
      return {
        title: "Frecuencia cardiaca por km",
        colorClass: "session-line-hr",
        yLabel: "ppm",
        invertScale: false,
        summary: `Media ${selectedActivity.avgHr} ppm · Max ${selectedActivity.maxHr} ppm`,
        formatValue: (value: number) => `${Math.round(value)} ppm`,
      };
    }
    return {
      title: "Elevacion acumulada por km",
      colorClass: "session-line-elevation",
      yLabel: "m",
      invertScale: false,
      summary: `Desnivel positivo ${selectedActivity.elevationGainM} m`,
      formatValue: (value: number) => `${Math.round(value)} m`,
    };
  }, [selectedActivity.avgHr, selectedActivity.avgPace, selectedActivity.elevationGainM, selectedActivity.maxHr, sessionMetric]);

  const chartGeometry = useMemo(() => {
    const width = 700;
    const height = 200;
    const padTop = 20;
    const padBottom = 28;
    const padLeft = 10;
    const padRight = 10;
    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;
    const values = sessionSeries;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    const points = values.map((value, index) => {
      const x = padLeft + (index / Math.max(1, values.length - 1)) * plotWidth;
      const norm = (value - min) / range;
      const scaled = sessionMetricMeta.invertScale ? 1 - norm : norm;
      const y = padTop + (1 - scaled) * plotHeight;
      const distanceKm = useStreamAxis
        ? Number(streamDistance[index] ?? 0)
        : index + 1;
      return { x, y, value, km: distanceKm };
    });

    const linePath = points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ");

    const areaPath =
      points.length > 1
        ? `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${(padTop + plotHeight).toFixed(2)} L ${points[0].x.toFixed(2)} ${(padTop + plotHeight).toFixed(2)} Z`
        : "";

    return { width, height, padTop, padBottom, padLeft, padRight, plotWidth, plotHeight, points, linePath, areaPath };
  }, [sessionMetricMeta.invertScale, sessionSeries, streamDistance, useStreamAxis]);

  const hoveredPoint =
    hoveredKm !== null ? chartGeometry.points[clamp(hoveredKm, 0, chartGeometry.points.length - 1)] ?? null : null;

  const axisLabels = useMemo(() => {
    if (chartGeometry.points.length === 0) {
      return { start: "Km 0", mid: "Km 0", end: "Km 0" };
    }
    const start = chartGeometry.points[0].km;
    const mid = chartGeometry.points[Math.floor(chartGeometry.points.length / 2)]?.km ?? start;
    const end = chartGeometry.points[chartGeometry.points.length - 1]?.km ?? start;
    if (useStreamAxis) {
      return {
        start: `${start.toFixed(1)} km`,
        mid: `${mid.toFixed(1)} km`,
        end: `${end.toFixed(1)} km`,
      };
    }
    return {
      start: `Km ${Math.max(1, Math.round(start))}`,
      mid: `Km ${Math.max(1, Math.round(mid))}`,
      end: `Km ${Math.max(1, Math.round(end))}`,
    };
  }, [chartGeometry.points, useStreamAxis]);

  const strideBursts = useMemo(() => {
    if (!useStreamAxis || streamPace.length < 20 || streamDistance.length !== streamPace.length) return [];
    const baseline = streamPace.reduce((sum, v) => sum + v, 0) / streamPace.length;
    const threshold = baseline - 22;
    const bursts: Array<{ startKm: number; endKm: number; pace: number }> = [];
    let start = -1;
    for (let i = 0; i < streamPace.length; i += 1) {
      const isFast = streamPace[i] <= threshold;
      if (isFast && start === -1) start = i;
      if ((!isFast || i === streamPace.length - 1) && start !== -1) {
        const end = isFast && i === streamPace.length - 1 ? i : i - 1;
        if (end - start >= 2) {
          const startKm = streamDistance[start];
          const endKm = streamDistance[end];
          const avgPace = Math.round(
            streamPace.slice(start, end + 1).reduce((s, v) => s + v, 0) / (end - start + 1),
          );
          if (endKm - startKm <= 0.35) {
            bursts.push({ startKm, endKm, pace: avgPace });
          }
        }
        start = -1;
      }
    }
    return bursts.slice(0, 10);
  }, [streamDistance, streamPace, useStreamAxis]);

  const goalProgress = (goal: Goal) => {
    if (goal.type === "weekly-km") {
      const percent = Math.round((latestWeek.distanceKm / goal.target) * 100);
      return Math.min(160, Math.max(0, percent));
    }
    if (goal.type === "weekly-load") {
      const percent = Math.round((latestWeek.load / goal.target) * 100);
      return Math.min(160, Math.max(0, percent));
    }

    const tenKPred = predictions.find((item) => item.label === "10K")?.predictedSeconds ?? 0;
    if (tenKPred === 0 || goal.target <= 0) return 0;
    const percent = Math.round((goal.target / tenKPred) * 100);
    return Math.min(160, Math.max(0, percent));
  };

  const goalProgressText = (goal: Goal) => {
    if (goal.type === "weekly-km") return `${latestWeek.distanceKm} / ${goal.target} km`;
    if (goal.type === "weekly-load") return `${latestWeek.load} / ${goal.target} load`;

    const tenKPred = predictions.find((item) => item.label === "10K")?.predictedSeconds ?? 0;
    return `${formatRaceTime(tenKPred)} vs objetivo ${formatRaceTime(goal.target)}`;
  };

  const addGoal = async () => {
    const target = Number(goalTarget);
    if (!goalTitle.trim() || !Number.isFinite(target) || target <= 0 || !goalDate) {
      return;
    }

    const raceDistance = raceDistanceKm.trim() ? Number(raceDistanceKm) : null;
    if (raceDistance !== null && (!Number.isFinite(raceDistance) || raceDistance <= 0)) {
      setGoalsError("La distancia de carrera no es valida.");
      return;
    }

    setGoalSaving(true);
    setGoalsError(null);
    try {
      const response = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: goalTitle.trim(),
          type: goalType,
          target,
          dueDate: goalDate,
          raceName: raceName.trim() || null,
          raceDistanceKm: raceDistance,
        }),
      });

      if (!response.ok) {
        throw new Error("No se pudo guardar el objetivo.");
      }

      const payload = (await response.json()) as { item?: Goal };
      if (payload.item) {
        setGoals((current) => [payload.item as Goal, ...current]);
      }

      setGoalTitle("");
      setRaceName("");
      setRaceDistanceKm("");
    } catch (saveError) {
      setGoalsError(saveError instanceof Error ? saveError.message : "Error al crear objetivo.");
    } finally {
      setGoalSaving(false);
    }
  };

  const startEditingGoal = (goal: Goal) => {
    setEditingGoalId(goal.id);
    setEditDraft({
      title: goal.title,
      type: goal.type,
      target: String(goal.target),
      dueDate: goal.dueDate,
      raceName: goal.raceName ?? "",
      raceDistanceKm: goal.raceDistanceKm ? String(goal.raceDistanceKm) : "",
    });
  };

  const cancelEditing = () => {
    setEditingGoalId(null);
    setEditDraft(null);
  };

  const saveGoal = async (goalId: string) => {
    if (!editDraft) return;
    const target = Number(editDraft.target);
    const raceDistance = editDraft.raceDistanceKm.trim() ? Number(editDraft.raceDistanceKm) : null;
    if (!editDraft.title.trim() || !Number.isFinite(target) || target <= 0 || !editDraft.dueDate) {
      setGoalsError("Revisa los datos del objetivo antes de guardar.");
      return;
    }
    if (raceDistance !== null && (!Number.isFinite(raceDistance) || raceDistance <= 0)) {
      setGoalsError("La distancia de carrera no es valida.");
      return;
    }

    setGoalsError(null);
    try {
      const response = await fetch(`/api/goals/${goalId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editDraft.title.trim(),
          type: editDraft.type,
          target,
          dueDate: editDraft.dueDate,
          raceName: editDraft.raceName.trim() || null,
          raceDistanceKm: raceDistance,
        }),
      });
      if (!response.ok) {
        throw new Error("No se pudo actualizar el objetivo.");
      }
      const payload = (await response.json()) as { item?: Goal };
      if (payload.item) {
        setGoals((current) =>
          current.map((goal) => (goal.id === goalId ? (payload.item as Goal) : goal)),
        );
      }
      cancelEditing();
    } catch (updateError) {
      setGoalsError(updateError instanceof Error ? updateError.message : "Error al actualizar.");
    }
  };

  const toggleGoalCompleted = async (goal: Goal) => {
    const newStatus: GoalStatus = goal.status === "completed" ? "active" : "completed";
    try {
      const response = await fetch(`/api/goals/${goal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!response.ok) {
        throw new Error("No se pudo actualizar estado.");
      }
      const payload = (await response.json()) as { item?: Goal };
      if (payload.item) {
        setGoals((current) =>
          current.map((item) => (item.id === goal.id ? (payload.item as Goal) : item)),
        );
      }
    } catch (toggleError) {
      setGoalsError(toggleError instanceof Error ? toggleError.message : "Error al cambiar estado.");
    }
  };

  const removeGoal = async (goalId: string) => {
    setGoalDeletingId(goalId);
    setGoalsError(null);
    try {
      const response = await fetch(`/api/goals/${goalId}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error("No se pudo eliminar el objetivo.");
      }
      setGoals((current) => current.filter((goal) => goal.id !== goalId));
    } catch (deleteError) {
      setGoalsError(deleteError instanceof Error ? deleteError.message : "Error al eliminar objetivo.");
    } finally {
      setGoalDeletingId(null);
    }
  };

  const syncStravaNow = async () => {
    setStravaSyncing(true);
    setStravaSyncMessage("Sincronizando actividades de Strava...");
    try {
      const response = await fetch("/api/strava/sync", { method: "POST" });
      const payload = (await response.json()) as SyncApiResult;
      if (!response.ok) {
        throw new Error(payload.error || "No se pudo completar la sincronizacion.");
      }
      if (payload.status === "throttled") {
        const retryAt = formatRetryAt(payload.retryAtUtc);
        setStravaSyncMessage(
          `${payload.message ?? "Sync pausada por cuota."}${retryAt ? ` Vuelve a intentar desde ${retryAt}.` : ""}`,
        );
      } else {
        setStravaSyncMessage(
          `Sync completada: ${payload.importedCount ?? 0} nuevas, ${payload.updatedCount ?? 0} actualizadas.`,
        );
      }
      updateQuotaMessage(payload.quota ?? null);
      await refreshStravaOverview();
    } catch (syncError) {
      setStravaSyncMessage(syncError instanceof Error ? syncError.message : "Error en sincronizacion.");
    } finally {
      setStravaSyncing(false);
    }
  };

  const runBackfill = async () => {
    setStravaBackfilling(true);
    setStravaSyncMessage("Backfill historico en progreso...");
    try {
      const response = await fetch("/api/strava/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromDate: backfillFromDate || undefined,
          includeStreams: false,
          maxPages: 3,
          maxRequests: 60,
        }),
      });
      const payload = (await response.json()) as SyncApiResult;
      if (!response.ok) {
        throw new Error(payload.error || "No se pudo ejecutar backfill.");
      }
      if (payload.status === "throttled") {
        const retryAt = formatRetryAt(payload.retryAtUtc);
        setStravaSyncMessage(
          `${payload.message ?? "Backfill pausado por cuota."}${retryAt ? ` Reanuda desde ${retryAt}.` : ""}`,
        );
      } else {
        setStravaSyncMessage(
          `Backfill OK: +${payload.importedCount ?? 0} nuevas, ${payload.updatedCount ?? 0} actualizadas (${payload.requestsUsed ?? 0} requests).`,
        );
      }
      updateQuotaMessage(payload.quota ?? null);
      await refreshStravaOverview();
    } catch (backfillError) {
      setStravaSyncMessage(backfillError instanceof Error ? backfillError.message : "Error en backfill.");
    } finally {
      setStravaBackfilling(false);
    }
  };

  const analyzeActivity = () => {
    startTransition(async () => {
      setError(null);
      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ activityId: selectedActivity.id }),
        });

        if (!response.ok) {
          throw new Error("No se pudo analizar la actividad.");
        }

        const payload = (await response.json()) as AnalyzeResponse;
        setAnalysis(payload);
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Error inesperado en el analisis.",
        );
      }
    });
  };

  const handleChartMove = (event: MouseEvent<SVGSVGElement>) => {
    if (!chartRef.current || chartGeometry.points.length === 0) return;
    const rect = chartRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left - chartGeometry.padLeft;
    const ratio = clamp(x / Math.max(1, chartGeometry.plotWidth), 0, 1);
    const index = Math.round(ratio * (chartGeometry.points.length - 1));
    setHoveredKm(index);
  };

  const handleChartLeave = () => setHoveredKm(null);

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="kicker">StrideOS Running</p>
          <h1>Dashboard de actividades, predicts y objetivos</h1>
          <p className="subtitle">
            Historial, metricas de rendimiento, graficas de sesion, prediccion de carrera y analisis
            automatizado con IA.
          </p>
          <div className="strava-connect">
            <span className={`status-dot${stravaConnected ? " is-on" : ""}`} />
            <span>
              {stravaConnected
                ? `Strava conectado${stravaExpiresAt ? ` (expira ${stravaExpiresAt.slice(0, 10)})` : ""}`
                : "Strava no conectado"}
            </span>
            <a className="strava-link" href="/api/strava/connect">
              {stravaConnected ? "Reconectar Strava" : "Conectar Strava"}
            </a>
            {stravaConnected ? (
              <button className="strava-sync-button" disabled={stravaSyncing} onClick={syncStravaNow} type="button">
                {stravaSyncing ? "Sincronizando..." : "Sincronizar ahora"}
              </button>
            ) : null}
            {stravaConnected ? (
              <button
                className="strava-sync-button strava-backfill-button"
                disabled={stravaBackfilling}
                onClick={runBackfill}
                type="button"
              >
                {stravaBackfilling ? "Backfill..." : "Backfill historico"}
              </button>
            ) : null}
            {stravaConnected ? (
              <input
                className="strava-date-input"
                type="date"
                value={backfillFromDate}
                onChange={(event) => setBackfillFromDate(event.target.value)}
                title="Fecha minima para backfill (opcional)"
              />
            ) : null}
          </div>
          <div className="strava-meta">
            {stravaSyncMessage ? <p className="strava-sync-message">{stravaSyncMessage}</p> : null}
            {stravaHistoryMessage ? (
              <p className="strava-sync-message strava-sync-message-soft">{stravaHistoryMessage}</p>
            ) : null}
            {stravaQuotaMessage ? (
              <p className="strava-sync-message strava-sync-message-soft">{stravaQuotaMessage}</p>
            ) : null}
          </div>
          {activitiesLoading ? <p className="strava-sync-message">Cargando actividades reales...</p> : null}
          {activitiesError ? <p className="error-message">{activitiesError}</p> : null}
        </div>
        <div className="header-badges">
          {targets.map((target) => (
            <article key={target.label} className="header-pill">
              <span>{target.label}</span>
              <strong>{target.value}</strong>
            </article>
          ))}
        </div>
      </header>

      <section className="kpi-grid">
        {stats.map((stat) => (
          <article key={stat.label} className="kpi-card">
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
            <small>{stat.helper}</small>
          </article>
        ))}
      </section>

      <section className="content-grid">
        <aside className="panel activity-list-panel">
          <div className="panel-head">
            <h2>Actividades</h2>
            <span>{visibleActivities.length} sesiones</span>
          </div>

          <div className="activity-week-nav">
            <button
              type="button"
              className="week-nav-button"
              onClick={() => setWeekCursor((current) => Math.min(current + 1, Math.max(0, activityWeeks.length - 1)))}
              disabled={safeWeekCursor >= activityWeeks.length - 1}
            >
              Semana anterior
            </button>
            <span className="week-label">{activityWeeks[safeWeekCursor]?.label ?? "Sin semana"}</span>
            <button
              type="button"
              className="week-nav-button"
              onClick={() => setWeekCursor((current) => Math.max(0, current - 1))}
              disabled={safeWeekCursor <= 0}
            >
              Semana siguiente
            </button>
          </div>

          <div className="activity-list">
            {visibleActivities.map((activity) => {
              const isActive = activity.id === selectedActivity.id;
              return (
                <button
                  className={`activity-item${isActive ? " is-active" : ""}`}
                  key={activity.id}
                  onClick={() => setSelectedId(activity.id)}
                  type="button"
                >
                  <div className="activity-item-head">
                    <span>{activity.workoutType}</span>
                    <strong>{sourceLabel[activity.source]}</strong>
                  </div>
                  <h3>{activity.title}</h3>
                  <p>{formatDate(activity.date)}</p>
                  <div className="activity-item-metrics">
                    <span>{activity.distanceKm.toFixed(1)} km</span>
                    <span>{activity.avgPace}</span>
                    <span>TSS {activity.tss}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="panel detail-panel">
          <div className="panel-head">
            <div>
              <h2>{selectedActivity.title}</h2>
              <p>{selectedActivity.planTarget}</p>
            </div>
            <button className="analyze-button" disabled={isPending} onClick={analyzeActivity} type="button">
              {isPending ? "Analizando..." : "Analizar con IA"}
            </button>
          </div>

          <div className="detail-metrics-grid">
            <article>
              <span>Distancia</span>
              <strong>{selectedActivity.distanceKm.toFixed(1)} km</strong>
            </article>
            <article>
              <span>Tiempo mov.</span>
              <strong>{selectedActivity.movingTimeMin} min</strong>
            </article>
            <article>
              <span>Ritmo medio</span>
              <strong>{selectedActivity.avgPace}</strong>
            </article>
            <article>
              <span>FC media</span>
              <strong>{selectedActivity.avgHr} ppm</strong>
            </article>
            <article>
              <span>Cadencia</span>
              <strong>{selectedActivity.cadence} spm</strong>
            </article>
            <article>
              <span>Potencia</span>
              <strong>{selectedActivity.avgPower} W</strong>
            </article>
          </div>

          <article className="session-chart-card">
            <div className="session-chart-head">
              <h3>{sessionMetricMeta.title}</h3>
              <div className="session-tabs">
                <button
                  type="button"
                  className={`session-tab${sessionMetric === "pace" ? " is-active" : ""}`}
                  onClick={() => setSessionMetric("pace")}
                >
                  Ritmo
                </button>
                <button
                  type="button"
                  className={`session-tab${sessionMetric === "hr" ? " is-active" : ""}`}
                  onClick={() => setSessionMetric("hr")}
                >
                  FC
                </button>
                <button
                  type="button"
                  className={`session-tab${sessionMetric === "elevation" ? " is-active" : ""}`}
                  onClick={() => setSessionMetric("elevation")}
                >
                  Elevacion
                </button>
              </div>
            </div>

            {sessionSeries.length > 1 ? (
              <>
                <svg
                  ref={chartRef}
                  className="session-chart"
                  viewBox={`0 0 ${chartGeometry.width} ${chartGeometry.height}`}
                  role="img"
                  onMouseMove={handleChartMove}
                  onMouseLeave={handleChartLeave}
                >
                  <defs>
                    <linearGradient id="session-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgba(114, 210, 255, 0.26)" />
                      <stop offset="100%" stopColor="rgba(114, 210, 255, 0.02)" />
                    </linearGradient>
                  </defs>
                  <path className="session-area" d={chartGeometry.areaPath} fill="url(#session-fill)" />
                  <path
                    className={`session-line ${sessionMetricMeta.colorClass}`}
                    d={chartGeometry.linePath}
                    fill="none"
                  />
                  {hoveredPoint ? (
                    <>
                      <line
                        className="session-cursor-line"
                        x1={hoveredPoint.x}
                        y1={chartGeometry.padTop}
                        x2={hoveredPoint.x}
                        y2={chartGeometry.height - chartGeometry.padBottom}
                      />
                      <circle className="session-cursor-dot" cx={hoveredPoint.x} cy={hoveredPoint.y} r={5} />
                    </>
                  ) : null}
                </svg>
                <div className="session-axis">
                  <span>{axisLabels.start}</span>
                  <span>{axisLabels.mid}</span>
                  <span>{axisLabels.end}</span>
                </div>
                <p className="session-summary">{sessionMetricMeta.summary}</p>
                {hoveredPoint ? (
                  <div className="session-tooltip">
                    <strong>{useStreamAxis ? `${hoveredPoint.km.toFixed(2)} km` : `Km ${Math.round(hoveredPoint.km)}`}</strong>
                    <span>{sessionMetricMeta.formatValue(hoveredPoint.value)}</span>
                    <small>Fuente: {selectedActivity.seriesSource ?? "summary"}</small>
                  </div>
                ) : null}
                {sessionMetric === "pace" && strideBursts.length > 0 ? (
                  <div className="stride-tags">
                    {strideBursts.map((burst, index) => (
                      <span key={`${selectedActivity.id}-stride-${index}`}>
                        Stride {index + 1}: {burst.startKm.toFixed(2)}-{burst.endKm.toFixed(2)} km @ {formatPaceFromSeconds(burst.pace)}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="session-splits-row">
                  {(useStreamAxis
                    ? chartGeometry.points
                        .filter((_, index) => index % Math.max(1, Math.floor(chartGeometry.points.length / 16)) === 0)
                        .slice(0, 16)
                        .map((point) => ({ label: `${point.km.toFixed(1)} km`, value: point.value }))
                    : sessionSeries.slice(0, 16).map((value, index) => ({ label: `K${index + 1}`, value }))
                  ).map((item, index) => (
                    <span key={`${selectedActivity.id}-metric-${sessionMetric}-${index + 1}`}>
                      {item.label}: {sessionMetricMeta.formatValue(item.value)}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="session-summary">No hay datos suficientes por tramos para esta métrica.</p>
            )}
          </article>

          <div className="notes">
            <h3>Notas de sesion</h3>
            <p>{selectedActivity.notes}</p>
          </div>

          <div className="analysis-card">
            <div className="analysis-head">
              <h3>Analisis IA</h3>
              {analysis ? (
                <span className="score-pill">Score {analysis.score}/100</span>
              ) : (
                <span className="score-pill score-pill--muted">Pendiente</span>
              )}
            </div>
            {error ? <p className="error-message">{error}</p> : null}
            {analysis ? (
              <>
                <p className="analysis-summary">{analysis.summary}</p>
                <ul>
                  {analysis.insights.map((insight) => (
                    <li key={insight}>{insight}</li>
                  ))}
                </ul>
                <p className="analysis-recommendation">{analysis.recommendation}</p>
                <small>
                  Motor: {analysis.source === "openai" ? analysis.model ?? "OpenAI" : "Fallback local"}
                </small>
              </>
            ) : (
              <p>
                Pulsa <strong>Analizar con IA</strong> para obtener una lectura del entrenamiento y una
                recomendacion concreta para la siguiente sesion.
              </p>
            )}
          </div>
        </section>
      </section>

      <section className="race-goals-grid">
        <article className="panel race-panel">
          <div className="panel-head">
            <h2>Predicts de carrera</h2>
            <span>Confianza {confidence}%</span>
          </div>
          <p className="panel-copy">
            Basado en tus ultimas {recentRunActivities.length} sesiones utiles y escalado con modelo de fatiga.
          </p>
          <div className="predict-grid">
            {predictions.map((prediction) => (
              <div className="predict-card" key={prediction.label}>
                <span>{prediction.label}</span>
                <strong>{formatRaceTime(prediction.predictedSeconds)}</strong>
                <small>{formatPaceFromSeconds(prediction.predictedSeconds / prediction.distanceKm)} min/km</small>
              </div>
            ))}
          </div>
          <p className="panel-copy">
            Base equivalente 10K: {formatRaceTime(Math.round(baselinePerformance.baseSeconds))}.
          </p>
        </article>

        <article className="panel goals-panel">
          <div className="panel-head">
            <h2>Proximos objetivos</h2>
            <span>{goals.length} activos</span>
          </div>

          <div className="goal-form goal-form-new">
            <input
              placeholder="Ej: Media maraton Bogota"
              value={goalTitle}
              onChange={(event) => setGoalTitle(event.target.value)}
            />
            <select value={goalType} onChange={(event) => setGoalType(event.target.value as GoalType)}>
              <option value="weekly-km">Km semana</option>
              <option value="weekly-load">Carga semanal</option>
              <option value="10k-time">Tiempo 10K (seg)</option>
            </select>
            <input
              placeholder="Meta"
              type="number"
              value={goalTarget}
              onChange={(event) => setGoalTarget(event.target.value)}
            />
            <input type="date" value={goalDate} onChange={(event) => setGoalDate(event.target.value)} />
            <input
              placeholder="Carrera (opcional)"
              value={raceName}
              onChange={(event) => setRaceName(event.target.value)}
            />
            <input
              placeholder="Distancia carrera km"
              type="number"
              value={raceDistanceKm}
              onChange={(event) => setRaceDistanceKm(event.target.value)}
            />
            <button className="goal-add-button" type="button" onClick={addGoal} disabled={goalSaving}>
              {goalSaving ? "Guardando..." : "Crear objetivo"}
            </button>
          </div>

          {goalsError ? <p className="error-message">{goalsError}</p> : null}
          {goalsLoading ? <p className="panel-copy">Cargando objetivos...</p> : null}

          <div className="goals-list">
            {goals.map((goal) => {
              const progress = goalProgress(goal);
              const isEditing = editingGoalId === goal.id && editDraft !== null;
              return (
                <div className={`goal-card${goal.status === "completed" ? " is-completed" : ""}`} key={goal.id}>
                  <div className="goal-head">
                    <div>
                      <h3>{goal.title}</h3>
                      <p>
                        {goalTypeLabel[goal.type]} · objetivo {formatGoalTarget(goal)} · {goal.dueDate}
                      </p>
                      {goal.raceName ? (
                        <p>
                          Carrera: {goal.raceName}
                          {goal.raceDistanceKm ? ` (${goal.raceDistanceKm} km)` : ""}
                        </p>
                      ) : null}
                    </div>
                    <div className="goal-actions">
                      <span className={`goal-status-badge goal-status-${goal.status}`}>{statusLabel[goal.status]}</span>
                      <button className="goal-remove" type="button" onClick={() => toggleGoalCompleted(goal)}>
                        {goal.status === "completed" ? "Reabrir" : "Completar"}
                      </button>
                      <button className="goal-remove" type="button" onClick={() => startEditingGoal(goal)}>
                        Editar
                      </button>
                      <button
                        className="goal-remove"
                        type="button"
                        onClick={() => removeGoal(goal.id)}
                        disabled={goalDeletingId === goal.id}
                      >
                        {goalDeletingId === goal.id ? "Quitando..." : "Quitar"}
                      </button>
                    </div>
                  </div>

                  {isEditing ? (
                    <div className="goal-form goal-form-edit">
                      <input
                        value={editDraft.title}
                        onChange={(event) =>
                          setEditDraft((current) => (current ? { ...current, title: event.target.value } : current))
                        }
                      />
                      <select
                        value={editDraft.type}
                        onChange={(event) =>
                          setEditDraft((current) =>
                            current ? { ...current, type: event.target.value as GoalType } : current,
                          )
                        }
                      >
                        <option value="weekly-km">Km semana</option>
                        <option value="weekly-load">Carga semanal</option>
                        <option value="10k-time">Tiempo 10K (seg)</option>
                      </select>
                      <input
                        type="number"
                        value={editDraft.target}
                        onChange={(event) =>
                          setEditDraft((current) => (current ? { ...current, target: event.target.value } : current))
                        }
                      />
                      <input
                        type="date"
                        value={editDraft.dueDate}
                        onChange={(event) =>
                          setEditDraft((current) => (current ? { ...current, dueDate: event.target.value } : current))
                        }
                      />
                      <input
                        placeholder="Carrera"
                        value={editDraft.raceName}
                        onChange={(event) =>
                          setEditDraft((current) => (current ? { ...current, raceName: event.target.value } : current))
                        }
                      />
                      <input
                        type="number"
                        placeholder="Km carrera"
                        value={editDraft.raceDistanceKm}
                        onChange={(event) =>
                          setEditDraft((current) =>
                            current ? { ...current, raceDistanceKm: event.target.value } : current,
                          )
                        }
                      />
                      <button className="goal-add-button" type="button" onClick={() => saveGoal(goal.id)}>
                        Guardar
                      </button>
                      <button className="goal-cancel-button" type="button" onClick={cancelEditing}>
                        Cancelar
                      </button>
                    </div>
                  ) : null}

                  <div className="goal-progress-track">
                    <div
                      className={`goal-progress-fill${progress >= 100 ? " is-good" : ""}`}
                      style={{ width: `${Math.min(progress, 100)}%` }}
                    />
                  </div>
                  <div className="goal-foot">
                    <span>{goalProgressText(goal)}</span>
                    <strong>{progress >= 100 ? "On track" : "Atencion"}</strong>
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      </section>

      <section className="trend-grid">
        <article className="panel trend-panel">
          <div className="panel-head">
            <h2>Tendencia semanal</h2>
            <span>Ultimas 6 semanas</span>
          </div>
          <div className="bars">
            {trend.map((point) => (
              <div className="bar-column" key={point.week}>
                <div className="bar-stack">
                  <span
                    className="bar bar-distance"
                    style={{ height: resolveBarHeight(point.distanceKm, maxDistance) }}
                  />
                  <span className="bar-label">{point.distanceKm} km</span>
                </div>
                <strong>{point.week}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="panel trend-panel">
          <div className="panel-head">
            <h2>Carga interna</h2>
            <span>TSS / semana</span>
          </div>
          <div className="bars">
            {trend.map((point) => (
              <div className="bar-column" key={`load-${point.week}`}>
                <div className="bar-stack">
                  <span className="bar bar-load" style={{ height: resolveBarHeight(point.load, maxLoad) }} />
                  <span className="bar-label">{point.load}</span>
                </div>
                <strong>{point.week}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="panel trend-panel">
          <div className="panel-head">
            <h2>Zonas de FC</h2>
            <span>Actividad seleccionada</span>
          </div>
          <div className="zones">
            {selectedActivity.zoneDistribution.map((zone) => {
              const totalMinutes = selectedActivity.zoneDistribution.reduce(
                (accumulator, current) => accumulator + current.minutes,
                0,
              );
              const percentage = totalMinutes > 0 ? Math.round((zone.minutes / totalMinutes) * 100) : 0;

              return (
                <div className="zone-row" key={zone.zone}>
                  <span>{zone.zone}</span>
                  <div className="zone-track">
                    <div className="zone-fill" style={{ width: `${percentage}%` }} />
                  </div>
                  <strong>
                    {zone.minutes} min ({percentage}%)
                  </strong>
                </div>
              );
            })}
          </div>
        </article>
      </section>

      <section className="split-table panel">
        <div className="panel-head">
          <h2>Splits por kilometro</h2>
          <span>{selectedActivity.splitsKm.length} tramos</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Km</th>
                <th>Pace</th>
                <th>Min/km</th>
              </tr>
            </thead>
            <tbody>
              {selectedActivity.splitsKm.map((split, index) => (
                <tr key={`${selectedActivity.id}-${index + 1}`}>
                  <td>{index + 1}</td>
                  <td>{split}s</td>
                  <td>{toMinutes(split)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

