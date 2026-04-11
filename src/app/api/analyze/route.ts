import { NextResponse } from "next/server";

import { runningActivities } from "@/lib/dashboard-data";

type AnalyzeRequest = {
  activityId?: string;
};

const paceToSeconds = (pace: string) => {
  const clean = pace.split(" ")[0];
  const [min, sec] = clean.split(":").map(Number);
  return min * 60 + sec;
};

const fallbackAnalysis = (activityId: string) => {
  const activity = runningActivities.find((item) => item.id === activityId);
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

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as AnalyzeRequest;
  const activityId = body.activityId ?? "";
  const activity = runningActivities.find((item) => item.id === activityId);

  if (!activity) {
    return NextResponse.json({ error: "Actividad no encontrada" }, { status: 404 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(fallbackAnalysis(activity.id));
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
      return NextResponse.json(fallbackAnalysis(activity.id));
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
    return NextResponse.json(fallbackAnalysis(activity.id));
  }
}
