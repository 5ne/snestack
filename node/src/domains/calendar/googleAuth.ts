import { OAuth2Client } from "google-auth-library";
import { Config } from "../../core/config";

export const CLIENT_ID_KEY = "SNESTACK_GOOGLE_CLIENT_ID";
export const CLIENT_SECRET_KEY = "SNESTACK_GOOGLE_CLIENT_SECRET";
export const REFRESH_TOKEN_KEY = "SNESTACK_GOOGLE_REFRESH_TOKEN";
export const REDIRECT_URI = "http://localhost:53682/oauth2callback";
export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

/** OAuth2 client from the registered Google Cloud "Desktop app" credentials. */
export function createOAuthClient(): OAuth2Client {
  const clientId = Config.require(CLIENT_ID_KEY);
  const clientSecret = Config.require(CLIENT_SECRET_KEY);
  return new OAuth2Client(clientId, clientSecret, REDIRECT_URI);
}

/** An OAuth2 client authorized with the stored refresh token, ready for read calls. */
export function getAuthorizedClient() {
  const client = createOAuthClient();
  const refreshToken = Config.require(REFRESH_TOKEN_KEY);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
