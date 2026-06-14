-- API key expiry. Nullable: NULL means the key never expires. authenticateApiKey
-- rejects a key whose expires_at is in the past (treated as not configured / 401).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
