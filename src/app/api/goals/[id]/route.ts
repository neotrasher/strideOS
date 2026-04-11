import { GoalStatus, GoalType } from "@prisma/client";
import { NextResponse } from "next/server";

import { ensureDemoUser } from "@/lib/demo-user";
import { prisma } from "@/lib/prisma";

type GoalTypeInput = "weekly-km" | "weekly-load" | "10k-time";
type GoalStatusInput = "active" | "completed" | "paused";

type UpdateGoalBody = {
  title?: string;
  type?: GoalTypeInput;
  status?: GoalStatusInput;
  target?: number;
  dueDate?: string;
  raceName?: string | null;
  raceDistanceKm?: number | null;
};

const mapGoalTypeToPrisma = (type: GoalTypeInput) => {
  if (type === "weekly-km") return GoalType.WEEKLY_KM;
  if (type === "weekly-load") return GoalType.WEEKLY_LOAD;
  return GoalType.TENK_TIME;
};

const mapGoalStatusToPrisma = (status: GoalStatusInput) => {
  if (status === "completed") return GoalStatus.COMPLETED;
  if (status === "paused") return GoalStatus.PAUSED;
  return GoalStatus.ACTIVE;
};

const mapGoalTypeFromPrisma = (type: GoalType) => {
  if (type === GoalType.WEEKLY_KM) return "weekly-km";
  if (type === GoalType.WEEKLY_LOAD) return "weekly-load";
  return "10k-time";
};

const mapGoalStatusFromPrisma = (status: GoalStatus) => {
  if (status === GoalStatus.COMPLETED) return "completed";
  if (status === GoalStatus.PAUSED) return "paused";
  return "active";
};

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "ID invalido." }, { status: 400 });
  }

  const user = await ensureDemoUser();
  const existingGoal = await prisma.goal.findUnique({ where: { id } });
  if (!existingGoal || existingGoal.userId !== user.id) {
    return NextResponse.json({ error: "Objetivo no encontrado." }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as UpdateGoalBody;
  const updateData: {
    title?: string;
    type?: GoalType;
    status?: GoalStatus;
    target?: number;
    dueDate?: Date;
    raceName?: string | null;
    raceDistanceKm?: number | null;
  } = {};

  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) {
      return NextResponse.json({ error: "El titulo es obligatorio." }, { status: 400 });
    }
    updateData.title = title;
  }

  if (body.type !== undefined) {
    updateData.type = mapGoalTypeToPrisma(body.type);
  }

  if (body.status !== undefined) {
    updateData.status = mapGoalStatusToPrisma(body.status);
  }

  if (body.target !== undefined) {
    const target = Number(body.target);
    if (!Number.isFinite(target) || target <= 0) {
      return NextResponse.json({ error: "Target invalido." }, { status: 400 });
    }
    updateData.target = target;
  }

  if (body.dueDate !== undefined) {
    const dueDate = new Date(body.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return NextResponse.json({ error: "Fecha invalida." }, { status: 400 });
    }
    updateData.dueDate = dueDate;
  }

  if (body.raceName !== undefined) {
    updateData.raceName = body.raceName?.trim() || null;
  }

  if (body.raceDistanceKm !== undefined) {
    if (body.raceDistanceKm === null) {
      updateData.raceDistanceKm = null;
    } else {
      const raceDistance = Number(body.raceDistanceKm);
      if (!Number.isFinite(raceDistance) || raceDistance <= 0) {
        return NextResponse.json({ error: "Distancia de carrera invalida." }, { status: 400 });
      }
      updateData.raceDistanceKm = raceDistance;
    }
  }

  const goal = await prisma.goal.update({
    where: { id },
    data: updateData,
  });

  return NextResponse.json({
    item: {
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
    },
  });
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "ID invalido." }, { status: 400 });
  }

  const user = await ensureDemoUser();
  const goal = await prisma.goal.findUnique({ where: { id } });
  if (!goal || goal.userId !== user.id) {
    return NextResponse.json({ error: "Objetivo no encontrado." }, { status: 404 });
  }

  await prisma.goal.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}

