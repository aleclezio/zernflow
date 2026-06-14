-- AI intent recognition toggle.
-- Opt-in per workspace: configuring an AI Gateway key (ai_api_key) for the
-- AI-response flow node must NOT silently enable per-message LLM intent
-- classification, which fires on every UNMATCHED inbound message. Default off.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ai_intent_enabled BOOLEAN NOT NULL DEFAULT false;
