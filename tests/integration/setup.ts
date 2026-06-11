import { config } from "dotenv";
import { resolve } from "node:path";

// Integration tests run against the local `supabase start` stack.
// scripts/dev-env.mjs writes .env.local; CI writes it the same way.
config({ path: resolve(__dirname, "../../.env.local") });

for (const key of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
]) {
  if (!process.env[key]) {
    throw new Error(
      `${key} is not set. Run \`npx supabase start\` then \`node scripts/dev-env.mjs\`.`
    );
  }
}
