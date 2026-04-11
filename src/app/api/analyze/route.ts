import { NextResponse } from "next/server";

import { runningActivities } from "@/lib/dashboard-data";
import { ensureDemoUser } from "@/lib/demo-user";
import { prisma } from "@/lib/prisma";

type AnalyzeRequest = {
  activityId?: string;
};

type AnalysisActivity = {
  id: string;
  title: string;
  workoutType: string;
  planTarget: string;
  notes: string;
  distanceKm: number;
  avgPace: string;
  avgHr: number;
  maxHr: number;
  cadence: number;
  tss: number;
  rpe: number;
};

const paceToSeconds = (pace: string) => {
  const clean = pace.split(" ")[0];
  const [min, sec] = clean.split(":").map(Number);
  return min * 60 + sec;
};

const fallbackAnalysis = (activity: AnalysisActivity | null) => {
  if (!activity) {
    return {
      summary: "No encontramos la actividad solicitada.",
      insights: [],
      recommendation: "Selecciona una actividad valida para analizar.",
      score: 0,
      source: "fallback",
    };
  }

  const targetPaceSec = 280;
  const paceSec = paceToSeconds(activity.avgPace);
  const paceDelta = paceSec - targetPaceSec;
  const hrStress = activity.avgHr > 168;
  const loadStress = activity.tss > 84;
  const score = Math.max(55, 100 - Math.max(0, paceDelta) * 0.7 - (hrStress ? 6 : 0) - (loadStress ? 4 : 0));

  const insights = [
    `Sesion: ${activity.workoutType} de ${activity.distanceKm.toFixed(1)} km con TSS ${activity.tss}.`,
    `Ritmo medio: ${activity.avgPace} y FC media: ${activity.avgHr} ppm.`,
    paceDelta > 0
      ? `El ritmo estuvo ${paceDelta}s/km por encima del objetivo de umbral.`
      : `El ritmo estuvo dentro o mejor que el objetivo de umbral.`,
  ];

  const recommendation =
    hrStress || loadStress
      ? "Haz la siguiente sesion en Z2 estricta, reduce volumen 10-15% y prioriza recuperacion."
      : "Puedes mantener el plan previsto; solo cuida la recuperacion post sesion.";

  return {
    summary: `${activity.title}: ejecucion ${score >= 80 ? "solida" : "mejorable"} respecto al plan.`,
    insights,
    recommendation,
    score: Math.round(score),
    source: "fallback",
  };
};

const secPerKmToPace = (secPerKm: number | null) => {
  if (!secPerKm || secPerKm <= 0) return "0:00 /km";
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${String(sec).padStart(2, "0")} /km`;
};

const mapDbActivityToInput = (activity: {
  id: string;
  name: string;
  sport: string;
  summary: string | null;
  distanceM: number | null;
  movingTimeS: number | null;
  averageHr: number | null;
  maxHr: number | null;
  averageCadence: number | null;
  averagePaceSecondsKm: number | null;
  rpe: number | null;
  rawPayload: unknown;
}): AnalysisActivity => {
  const detail = (activity.rawPayload &&
  typeof activity.rawPayload === "object" &&
  !Array.isArray(activity.rawPayload) &&
  typeof (activity.rawPayload as { detail?: unknown }).detail === "object")
    ? ((activity.rawPayload as { detail?: Record<string, unknown> }).detail ?? null)
    : null;

  const sufferScoreRaw = detail && typeof detail.suffer_score === "number" ? detail.suffer_score : null;
  const distanceKm = (activity.distanceM ?? 0) / 1000;
  const paceSec =
    activity.averagePaceSecondsKm ??
    ((activity.movingTimeS ?? 0) > 0 && distanceKm > 0 ? (activity.movingTimeS ?? 0) / distanceKm : null);
  const tss =
    sufferScoreRaw !== null ? Math.round(sufferScoreRaw) : Math.max(10, Math.round(((activity.movingTimeS ?? 0) / 60) * 1.2));

  return {
    id: activity.id,
    title: activity.name,
    workoutType: activity.sport.replaceAll("_", " "),
    planTarget: `Sesion ${activity.sport === "RUN" ? "running" : "cardio"} de ${distanceKm.toFixed(1)} km.`,
    notes: activity.summary ?? "Sin notas.",
    distanceKm: Math.round(distanceKm * 10) / 10,
    avgPace: secPerKmToPace(paceSec ? Math.round(paceSec) : null),
    avgHr: activity.averageHr ?? 0,
    maxHr: activity.maxHr ?? 0,
    cadence: Math.round(activity.averageCadence ?? 0),
    tss,
    rpe: activity.rpe ?? Math.min(10, Math.max(2, Math.round(tss / 12))),
  };
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as AnalyzeRequest;
  const activityId = body.activityId ?? "";
  const user = await ensureDemoUser();

  const dbActivity = await prisma.activity.findFirst({
    where: {
      id: activityId,
      userId: user.id,
    },
    select: {
      id: true,
      name: true,
      sport: true,
      summary: true,
      distanceM: true,
      movingTimeS: true,
      averageHr: true,
      maxHr: true,
      averageCadence: true,
      averagePaceSecondsKm: true,
      rpe: true,
      rawPayload: true,
    },
  });
  const mockActivity = runningActivities.find((item) => item.id === activityId);
  const activity = dbActivity ? mapDbActivityToInput(dbActivity) : (mockActivity ?? null);

  if (!activity) {
    return NextResponse.json({ error: "Actividad no encontrada" }, { status: 404 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(fallbackAnalysis(activity));
  }

  try {
    const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    const prompt = [
      "Eres un entrenador de running con foco en decisiones accionables.",
      "Devuelve una respuesta JSON con claves: summary, insights, recommendation, score.",
      "score debe ir de 0 a 100.",
      "No uses markdown.",
      "",
      `Actividad: ${activity.title}`,
      `Tipo: ${activity.workoutType}`,
      `Objetivo del plan: ${activity.planTarget}`,
      `Distancia (km): ${activity.distanceKm}`,
      `Ritmo medio: ${activity.avgPace}`,
      `FC media: ${activity.avgHr}`,
      `FC maxima: ${activity.maxHr}`,
      `Cadencia: ${activity.cadence}`,
      `TSS: ${activity.tss}`,
      `RPE: ${activity.rpe}`,
      `Notas: ${activity.notes}`,
    ].join("\n");

    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Eres un entrenador de running. Responde solo JSON valido con claves: summary, insights, recommendation, score.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!aiResponse.ok) {
      return NextResponse.json(fallbackAnalysis(activity));
    }

    const payload = (await aiResponse.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    const content = payload.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as {
      summary?: string;
      insights?: string[];
      recommendation?: string;
      score?: number;
    };

    return NextResponse.json({
      summary: parsed.summary ?? "Analisis generado.",
      insights: Array.isArray(parsed.insights) ? parsed.insights : [],
      recommendation: parsed.recommendation ?? "Sin recomendacion adicional.",
      score: typeof parsed.score === "number" ? parsed.score : 75,
      source: "openai",
      model,
    });
  } catch {
    return NextResponse.json(fallbackAnalysis(activity));
  }
}
