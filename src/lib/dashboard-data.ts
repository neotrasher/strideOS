export type ActivitySource = "strava" | "garmin";

export type ZoneShare = {
  zone: string;
  minutes: number;
};

export type RunningActivity = {
  id: string;
  source: ActivitySource;
  seriesSource?: "streams" | "splits" | "summary";
  title: string;
  date: string;
  workoutType: string;
  planTarget: string;
  notes: string;
  distanceKm: number;
  movingTimeMin: number;
  elapsedTimeMin: number;
  elevationGainM: number;
  avgPace: string;
  avgHr: number;
  maxHr: number;
  cadence: number;
  avgPower: number;
  tss: number;
  rpe: number;
  splitsKm: number[];
  splitHr?: number[];
  splitElevation?: number[];
  paceSeriesSecPerKm: number[];
  hrSeries: number[];
  elevationSeries: number[];
  zoneDistribution: ZoneShare[];
};

export type WeeklyTrendPoint = {
  week: string;
  distanceKm: number;
  load: number;
  avgPaceSec: number;
};

export const weeklyTrend: WeeklyTrendPoint[] = [
  { week: "W09", distanceKm: 47, load: 218, avgPaceSec: 309 },
  { week: "W10", distanceKm: 52, load: 244, avgPaceSec: 305 },
  { week: "W11", distanceKm: 58, load: 286, avgPaceSec: 301 },
  { week: "W12", distanceKm: 54, load: 275, avgPaceSec: 304 },
  { week: "W13", distanceKm: 61, load: 319, avgPaceSec: 298 },
  { week: "W14", distanceKm: 64, load: 332, avgPaceSec: 296 },
];

export const runningActivities: RunningActivity[] = [
  {
    id: "run-240331-tempo",
    source: "strava",
    title: "Tempo 3x12 min",
    date: "2026-03-31T06:12:00Z",
    workoutType: "Tempo",
    planTarget: "3 bloques a 4:35-4:45/km con recuperacion corta",
    notes: "Buenas piernas al inicio, ultima repeticion con fatiga.",
    distanceKm: 14.2,
    movingTimeMin: 66,
    elapsedTimeMin: 69,
    elevationGainM: 121,
    avgPace: "4:38 /km",
    avgHr: 161,
    maxHr: 176,
    cadence: 178,
    avgPower: 292,
    tss: 87,
    rpe: 8,
    splitsKm: [292, 286, 282, 280, 279, 281, 284, 278, 276, 275, 279, 283, 295, 301],
    paceSeriesSecPerKm: [332, 319, 304, 289, 286, 282, 279, 277, 281, 278, 275, 279, 288, 294],
    hrSeries: [136, 142, 151, 158, 161, 163, 165, 166, 168, 170, 171, 172, 166, 154],
    elevationSeries: [8, 12, 18, 21, 25, 33, 36, 30, 22, 20, 19, 27, 31, 26],
    zoneDistribution: [
      { zone: "Z1", minutes: 6 },
      { zone: "Z2", minutes: 18 },
      { zone: "Z3", minutes: 14 },
      { zone: "Z4", minutes: 20 },
      { zone: "Z5", minutes: 8 },
    ],
  },
  {
    id: "run-240330-easy",
    source: "garmin",
    title: "Easy + strides",
    date: "2026-03-30T06:02:00Z",
    workoutType: "Easy",
    planTarget: "Rodaje suave Z2, 8-10 km",
    notes: "Sesion controlada. Pulso estable.",
    distanceKm: 9.7,
    movingTimeMin: 51,
    elapsedTimeMin: 53,
    elevationGainM: 54,
    avgPace: "5:17 /km",
    avgHr: 143,
    maxHr: 159,
    cadence: 174,
    avgPower: 236,
    tss: 48,
    rpe: 4,
    splitsKm: [323, 321, 319, 318, 315, 314, 312, 316, 311, 295],
    paceSeriesSecPerKm: [338, 331, 325, 320, 317, 316, 312, 315, 310, 300],
    hrSeries: [124, 130, 136, 140, 143, 145, 147, 146, 149, 151],
    elevationSeries: [3, 5, 7, 8, 10, 11, 9, 6, 5, 4],
    zoneDistribution: [
      { zone: "Z1", minutes: 12 },
      { zone: "Z2", minutes: 32 },
      { zone: "Z3", minutes: 6 },
      { zone: "Z4", minutes: 1 },
      { zone: "Z5", minutes: 0 },
    ],
  },
  {
    id: "run-240328-intervals",
    source: "strava",
    title: "10 x 400m VO2",
    date: "2026-03-28T05:52:00Z",
    workoutType: "Intervals",
    planTarget: "10 x 400m fuerte, recuperacion 200m trote",
    notes: "Buena mecanica. Ultimas repeticiones con menor potencia.",
    distanceKm: 11.4,
    movingTimeMin: 55,
    elapsedTimeMin: 61,
    elevationGainM: 73,
    avgPace: "4:49 /km",
    avgHr: 157,
    maxHr: 181,
    cadence: 181,
    avgPower: 308,
    tss: 81,
    rpe: 9,
    splitsKm: [335, 311, 280, 256, 247, 260, 248, 257, 249, 261, 253, 312],
    paceSeriesSecPerKm: [348, 330, 311, 280, 250, 244, 246, 249, 247, 252, 250, 262, 274, 320],
    hrSeries: [128, 136, 147, 159, 165, 171, 173, 175, 176, 178, 179, 171, 162, 149],
    elevationSeries: [4, 7, 9, 12, 15, 14, 16, 17, 13, 11, 10, 9, 8, 6],
    zoneDistribution: [
      { zone: "Z1", minutes: 5 },
      { zone: "Z2", minutes: 11 },
      { zone: "Z3", minutes: 10 },
      { zone: "Z4", minutes: 16 },
      { zone: "Z5", minutes: 13 },
    ],
  },
];

export const latestActivityId = runningActivities[0].id;

export const dashboardStats = [
  { label: "Km semana", value: "64.0", helper: "Objetivo 68 km" },
  { label: "Desnivel", value: "824 m", helper: "Mixto trail + asfalto" },
  { label: "Carga", value: "332", helper: "7 dias" },
  { label: "Adherencia", value: "92%", helper: "Plan 10K" },
];

export const trainingTargets = [
  { label: "Ritmo umbral", value: "4:35 - 4:45 /km" },
  { label: "FC umbral", value: "162 - 170 ppm" },
  { label: "Volumen semana", value: "68 km" },
];
