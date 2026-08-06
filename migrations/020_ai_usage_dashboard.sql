CREATE TABLE IF NOT EXISTS ai_provider_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  provider TEXT NOT NULL DEFAULT 'fal',
  model TEXT NOT NULL DEFAULT 'google/gemini-2.5-flash',
  input_cost_per_million_usd NUMERIC NOT NULL DEFAULT 0,
  output_cost_per_million_usd NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO ai_provider_settings (singleton) VALUES (TRUE) ON CONFLICT (singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  operation TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
  estimated_cost_usd NUMERIC NOT NULL DEFAULT 0, success BOOLEAN NOT NULL, error_code TEXT
);
CREATE INDEX IF NOT EXISTS ai_usage_events_created_at_idx ON ai_usage_events (created_at DESC);
