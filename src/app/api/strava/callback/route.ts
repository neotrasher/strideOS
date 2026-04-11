import { ConnectionProvider } from "@prisma/client";
import { NextResponse } from "next/server";

import { ensureDemoUser } from "@/lib/demo-user";
import { prisma } from "@/lib/prisma";

type StravaTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  athlete?: {
    id?: number;
  };
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const appUrl = process.env.APP_URL;

  if (error) {
    return NextResponse.redirect(`${appUrl ?? ""}/?strava=denied`);
  }

  if (!code) {
    return NextResponse.json({ error: "No se recibio codigo de autorizacion." }, { status: 400 });
  }

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret || !appUrl) {
    return NextResponse.json(
      { error: "Configura STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET y APP_URL." },
      { status: 500 },
    );
  }

  const tokenResponse = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    return NextResponse.redirect(`${appUrl}/?strava=token_error`);
  }

  const payload = (await tokenResponse.json()) as StravaTokenResponse;
  if (!payload.access_token || !payload.refresh_token || !payload.expires_at) {
    return NextResponse.redirect(`${appUrl}/?strava=token_invalid`);
  }

  const user = await ensureDemoUser();
  await prisma.connection.upsert({
    where: {
      id: `${user.id}-strava`,
    },
    update: {
      provider: ConnectionProvider.STRAVA,
      externalAthleteId: payload.athlete?.id ? String(payload.athlete.id) : null,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: new Date(payload.expires_at * 1000),
      isActive: true,
    },
    create: {
      id: `${user.id}-strava`,
      userId: user.id,
      provider: ConnectionProvider.STRAVA,
      externalAthleteId: payload.athlete?.id ? String(payload.athlete.id) : null,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: new Date(payload.expires_at * 1000),
      isActive: true,
    },
  });

  return NextResponse.redirect(`${appUrl}/?strava=connected`);
}

