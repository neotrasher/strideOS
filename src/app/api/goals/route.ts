import { GoalStatus, GoalType } from "@prisma/client";
import { NextResponse } from "next/server";

import { ensureDemoUser } from "@/lib/demo-user";
import { prisma } from "@/lib/prisma";

type GoalTypeInput = "weekly-km" | "weekly-load" | "10k-time";
type GoalStatusInput = "active" | "completed" | "paused";

type CreateGoalBody = {
  title?: string;
  type?: GoalTypeInput;
  target?: number;
  dueDate?: string;
  status?: GoalStatusInput;
  raceName?: string;
  raceDistanceKm?: number | null;
};

const mapGoalTypeToPrisma = (type: GoalTypeInput) => {
  if (type === "weekly-km") return GoalType.WEEKLY_KM;
  if (type === "weekly-load") return GoalType.WEEKLY_LOAD;
  return GoalType.TENK_TIME;
};

const mapGoalTypeFromPrisma = (type: GoalType) => {
  if (type === GoalType.WEEKLY_KM) return "weekly-km";
  if (type === GoalType.WEEKLY_LOAD) return "weekly-load";
  return "10k-time";
};

const mapGoalStatusToPrisma = (status: GoalStatusInput) => {
  if (status === "completed") return GoalStatus.COMPLETED;
  if (status === "paused") return GoalStatus.PAUSED;
  return GoalStatus.ACTIVE;
};

const mapGoalStatusFromPrisma = (status: GoalStatus) => {
  if (status === GoalStatus.COMPLETED) return "completed";
  if (status === GoalStatus.PAUSED) return "paused";
  return "active";
};

const mapGoalResponse = (goal: {
  id: string;
  title: string;
  type: GoalType;
  status: GoalStatus;
  target: number;
  dueDate: Date;
  raceName: string | null;
  raceDistanceKm: number | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: goal.id,
  title: goal.title,
  type: mapGoalTypeFromPrisma(goal.type),
  status: mapGoalStatusFromPrisma(goal.status),
  target: goal.target,
  dueDate: goal.dueDate.toISOString().slice(0, 10),
  raceName: goal.raceName,
  raceDistanceKm: goal.raceDistanceKm,
  createdAt: goal.createdAt.toISOString(),
  updatedAt: goal.updatedAt.toISOString(),
});

export async function GET() {
  const user = await ensureDemoUser();
  const goals = await prisma.goal.findMany({
    where: { userId: user.id },
    orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
  });

  return NextResponse.json({
    items: goals.map(mapGoalResponse),
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as CreateGoalBody;
  const title = body.title?.trim() ?? "";
  const target = Number(body.target);
  const dueDate = body.dueDate ? new Date(body.dueDate) : null;
  const type = body.type;
  const status = body.status ?? "active";
  const raceName = body.raceName?.trim() || null;
  const raceDistanceKm =
    body.raceDistanceKm === null || body.raceDistanceKm === undefined
      ? null
      : Number(body.raceDistanceKm);

  if (!title || !type || !Number.isFinite(target) || target <= 0 || !dueDate || Number.isNaN(dueDate.getTime())) {
    return NextResponse.json({ error: "Datos invalidos para crear objetivo." }, { status: 400 });
  }

  if (raceDistanceKm !== null && (!Number.isFinite(raceDistanceKm) || raceDistanceKm <= 0)) {
    return NextResponse.json({ error: "La distancia objetivo de carrera no es valida." }, { status: 400 });
  }

  const user = await ensureDemoUser();
  const goal = await prisma.goal.create({
    data: {
      userId: user.id,
      title,
      type: mapGoalTypeToPrisma(type),
      status: mapGoalStatusToPrisma(status),
      target,
      dueDate,
      raceName,
      raceDistanceKm,
    },
  });

  return NextResponse.json({ item: mapGoalResponse(goal) }, { status: 201 });
}

