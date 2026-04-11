import { ConnectionProvider } from "@prisma/client";

import { prisma } from "@/lib/prisma";

type StravaTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
};

type StravaTokenPayloadStrict = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

const ensureStravaEnv = () => {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Faltan STRAVA_CLIENT_ID o STRAVA_CLIENT_SECRET.");
  }
  return { clientId, clientSecret };
};

const refreshAccessToken = async (refreshToken: string): Promise<StravaTokenPayloadStrict> => {
  const { clientId, clientSecret } = ensureStravaEnv();
  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error("No se pudo refrescar token de Strava.");
  }

  const payload = (await response.json()) as StravaTokenPayload;
  if (!payload.access_token || !payload.refresh_token || !payload.expires_at) {
    throw new Error("Respuesta invalida al refrescar token de Strava.");
  }

  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: payload.expires_at,
  };
};

export const ensureValidStravaToken = async (userId: string): Promise<string> => {
  const connection = await prisma.connection.findFirst({
    where: {
      userId,
      provider: ConnectionProvider.STRAVA,
      isActive: true,
    },
  });

  if (!connection?.accessToken || !connection.refreshToken || !connection.expiresAt) {
    throw new Error("No hay conexion activa de Strava.");
  }

  const expiresInMs = connection.expiresAt.getTime() - Date.now();
  if (expiresInMs > 2 * 60 * 1000) {
    return connection.accessToken;
  }

  const refreshed = await refreshAccessToken(connection.refreshToken);
  await prisma.connection.update({
    where: { id: connection.id },
    data: {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: new Date(refreshed.expires_at * 1000),
      isActive: true,
    },
  });

  return refreshed.access_token;
};
