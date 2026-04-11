import { NextResponse } from "next/server";

const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";

export async function GET() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const appUrl = process.env.APP_URL;

  if (!clientId || !appUrl) {
    return NextResponse.json(
      { error: "Falta configurar STRAVA_CLIENT_ID o APP_URL para conectar Strava." },
      { status: 500 },
    );
  }

  const callbackUrl = `${appUrl.replace(/\/$/, "")}/api/strava/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: "code",
    approval_prompt: "auto",
    scope: "read,activity:read_all",
  });

  return NextResponse.redirect(`${STRAVA_AUTHORIZE_URL}?${params.toString()}`);
}

