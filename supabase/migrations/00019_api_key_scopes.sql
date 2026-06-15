-- Per-key API scopes (read / write / send).
-- Pre-scopes keys default to FULL access (read,write,send) so existing
-- integrations keep working unchanged; new keys set their scopes explicitly at
-- issue time. Enforced in lib/api-auth.ts (authorizeApiV1 requires the route's
-- scope; session auth is unaffected — full access).
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT ARRAY['read', 'write', 'send'];

-- Integrity: only the known scopes, and never an empty set (a scopeless key
-- could authenticate nothing and would be a confusing dead credential).
DO $$ BEGIN
  ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_valid
    CHECK (scopes <@ ARRAY['read', 'write', 'send']::text[] AND array_length(scopes, 1) >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
