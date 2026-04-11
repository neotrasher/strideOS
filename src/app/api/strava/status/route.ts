import { ConnectionProvider } from "@prisma/client";
import { NextResponse } from "next/server";

import { ensureDemoUser } from "@/lib/demo-user";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const user = await ensureDemoUser();
  const connection = await prisma.connection.findFirst({
    where: {
      userId: user.id,
      provider: ConnectionProvider.STRAVA,
      isActive: true,
    },
  });

  return NextResponse.json({
    connected: Boolean(connection),
    expiresAt: connection?.expiresAt?.toISOString() ?? null,
  });
}

