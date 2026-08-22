import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const pool = new Pool({
  connectionString: requiredEnv("DATABASE_URL"),
  max: 10,
});

export const authOptions = {
  appName: "Buzz",
  baseURL: requiredEnv("BETTER_AUTH_URL"),
  secret: requiredEnv("BETTER_AUTH_SECRET"),
  database: pool,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
  },
  trustedOrigins: [requiredEnv("BETTER_AUTH_URL"), "http://localhost:4173"],
} satisfies BetterAuthOptions;

export const auth = betterAuth(authOptions);

export async function migrateAuthDatabase() {
  const { runMigrations } = await getMigrations(authOptions);
  await runMigrations();
}

export async function requireSession(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}
