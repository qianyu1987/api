-- Relay Station v1 PostgreSQL schema.
--
-- Monetary values are integer CNY micros (1 CNY = 1,000,000 micros). Token
-- prices in model_prices are micros per million tokens. Request and response
-- bodies, prompts, and plaintext upstream credentials are never persisted.
-- The script is safe to run repeatedly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION relay_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION relay_prevent_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION relay_prevent_invite_code_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invite_code IS DISTINCT FROM OLD.invite_code THEN
    RAISE EXCEPTION 'invite_code is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION relay_sync_order_aliases()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Both names are retained for compatibility with the first service draft.
  -- Defaults are treated as omitted values so inserts using either vocabulary
  -- produce the same canonical order.
  IF NEW.kind = 'wallet_topup' AND NEW.order_type <> 'wallet_topup' THEN NEW.kind := NEW.order_type; END IF;
  IF NEW.order_type = 'wallet_topup' AND NEW.kind <> 'wallet_topup' THEN NEW.order_type := NEW.kind; END IF;
  IF NEW.payment_method = 'wechat' AND NEW.payment_provider NOT IN ('wechat_native', 'wechat') THEN NEW.payment_method := NEW.payment_provider; END IF;
  IF NEW.payment_provider = 'wechat_native' AND NEW.payment_method NOT IN ('wechat', 'wechat_native') THEN NEW.payment_provider := NEW.payment_method; END IF;
  IF NEW.payment_method = 'wechat' AND NEW.payment_provider = 'wechat_native' THEN NULL; END IF;
  IF NEW.payment_method = 'alipay' THEN NEW.payment_provider := 'alipay_precreate'; END IF;
  IF NEW.payment_provider = 'alipay_precreate' THEN NEW.payment_method := 'alipay'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION relay_sync_affiliate_aliases()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invited_user_id IS NULL THEN NEW.invited_user_id := NEW.invitee_user_id; END IF;
  IF NEW.invitee_user_id IS NULL THEN NEW.invitee_user_id := NEW.invited_user_id; END IF;
  IF NEW.payment_amount_micros IS NULL THEN NEW.payment_amount_micros := NEW.paid_amount_micros; END IF;
  IF NEW.reward_micros IS NULL THEN NEW.reward_micros := NEW.commission_micros; END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  email TEXT,
  email_verified_at TIMESTAMPTZ,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  invite_code TEXT NOT NULL,
  -- Compatibility projection; invitation_bindings is the referral source of truth.
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  CHECK (char_length(trim(username)) BETWEEN 3 AND 128),
  CHECK (email IS NULL OR email = lower(email)),
  CHECK (char_length(password_hash) >= 32),
  CHECK (char_length(invite_code) BETWEEN 6 AND 64),
  CHECK (invite_code = upper(invite_code)),
  CHECK (role IN ('user', 'admin')),
  CHECK (status IN ('active', 'suspended', 'disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci_unique ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_invite_code_unique ON users (invite_code);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_ci_unique ON users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_role_status_cursor_idx ON users (role, status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS email_verification_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 6,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (purpose IN ('registration')),
  CHECK (email = lower(email)),
  CHECK (char_length(code_hash) = 64),
  CHECK (attempts >= 0 AND attempts <= max_attempts),
  CHECK (max_attempts BETWEEN 1 AND 12)
);
CREATE INDEX IF NOT EXISTS email_verification_active_idx
  ON email_verification_challenges(email, purpose, created_at DESC)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS email_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts SMALLINT NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind IN ('low_balance')),
  CHECK (status IN ('queued', 'processing', 'sent', 'failed')),
  CHECK (recipient = lower(recipient)),
  CHECK (attempts >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS email_jobs_dedupe_unique
  ON email_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_jobs_delivery_idx
  ON email_jobs(status, available_at, created_at);

CREATE TABLE IF NOT EXISTS user_consents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  document_key TEXT NOT NULL,
  document_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (document_key IN ('login_terms', 'service_terms', 'privacy_policy')),
  CHECK (char_length(document_version) BETWEEN 1 AND 64)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_consents_once_per_version
  ON user_consents(user_id, document_key, document_version);
CREATE INDEX IF NOT EXISTS user_consents_user_cursor_idx
  ON user_consents(user_id, accepted_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS invitation_bindings (
  invitee_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  inviter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  invite_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (invitee_user_id <> inviter_user_id),
  CHECK (invite_code = upper(invite_code))
);
CREATE INDEX IF NOT EXISTS invitation_bindings_inviter_cursor_idx
  ON invitation_bindings (inviter_user_id, created_at DESC, invitee_user_id DESC);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  -- Encrypted once-only recovery material for an explicit CC Switch import.
  -- The plaintext key is never returned from list/authentication queries.
  encrypted_key TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (char_length(trim(name)) BETWEEN 1 AND 128),
  CHECK (char_length(key_prefix) BETWEEN 6 AND 64),
  CHECK (char_length(key_hash) = 64),
  CHECK (status IN ('active', 'revoked', 'disabled')),
  CHECK (revoked_at IS NULL OR status = 'revoked')
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_unique ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_user_cursor_idx ON api_keys (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS api_keys_user_status_idx ON api_keys (user_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys (key_prefix);

CREATE TABLE IF NOT EXISTS api_key_reveal_audits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL AND key_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS api_key_reveal_audits_user_cursor_idx
  ON api_key_reveal_audits(user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance_micros BIGINT NOT NULL DEFAULT 0,
  reserved_micros BIGINT NOT NULL DEFAULT 0,
  version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (balance_micros >= 0),
  CHECK (reserved_micros >= 0),
  CONSTRAINT wallets_reserved_within_balance CHECK (reserved_micros <= balance_micros),
  CHECK (version >= 0)
);

CREATE TABLE IF NOT EXISTS affiliate_wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance_micros BIGINT NOT NULL DEFAULT 0,
  lifetime_micros BIGINT NOT NULL DEFAULT 0,
  converted_micros BIGINT NOT NULL DEFAULT 0,
  version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (balance_micros >= 0),
  CHECK (lifetime_micros >= 0),
  CHECK (converted_micros >= 0),
  CHECK (version >= 0),
  CHECK (converted_micros <= lifetime_micros)
);

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL DEFAULT ('plan-' || substr(gen_random_uuid()::text, 1, 8)),
  name TEXT NOT NULL,
  price_micros BIGINT NOT NULL,
  quota_micros BIGINT NOT NULL,
  duration_days SMALLINT NOT NULL DEFAULT 30,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(trim(code)) BETWEEN 1 AND 64),
  CHECK (char_length(trim(name)) BETWEEN 1 AND 128),
  CHECK (price_micros > 0),
  CHECK (quota_micros > 0),
  CHECK (duration_days = 30)
);
CREATE UNIQUE INDEX IF NOT EXISTS plans_code_ci_unique ON plans (lower(code));
CREATE INDEX IF NOT EXISTS plans_enabled_cursor_idx ON plans (enabled, active, display_order, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
  current_plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
  remaining_micros BIGINT NOT NULL DEFAULT 0,
  reserved_micros BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  last_purchase_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id),
  CHECK (remaining_micros >= 0),
  CHECK (reserved_micros >= 0),
  CONSTRAINT subscriptions_reserved_within_remaining CHECK (reserved_micros <= remaining_micros),
  CHECK (status IN ('active', 'expired', 'canceled')),
  CHECK (version >= 0),
  CHECK (expires_at IS NULL OR started_at IS NULL OR expires_at >= started_at)
);
CREATE INDEX IF NOT EXISTS subscriptions_status_expiry_idx ON subscriptions (status, expires_at, user_id);

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  encrypted_api_key TEXT,
  encrypted_extra_headers TEXT,
  model_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority INTEGER NOT NULL DEFAULT 100,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  supports_streaming BOOLEAN NOT NULL DEFAULT TRUE,
  circuit_open_until TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(trim(name)) BETWEEN 1 AND 128),
  CHECK (base_url ~ '^https?://'),
  CHECK (timeout_ms BETWEEN 1000 AND 120000),
  CHECK (priority >= 0),
  CHECK (failure_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS channels_name_ci_unique ON channels (lower(name));
CREATE INDEX IF NOT EXISTS channels_routing_idx ON channels (enabled, priority ASC, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS channel_model_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  requested_model TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(trim(requested_model)) BETWEEN 1 AND 256),
  CHECK (char_length(trim(upstream_model)) BETWEEN 1 AND 256)
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_model_mappings_unique ON channel_model_mappings (channel_id, requested_model);
CREATE INDEX IF NOT EXISTS channel_model_mappings_lookup_idx ON channel_model_mappings (requested_model, enabled, channel_id);

CREATE TABLE IF NOT EXISTS model_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_pattern TEXT NOT NULL,
  input_cost_micros BIGINT NOT NULL DEFAULT 0,
  output_cost_micros BIGINT NOT NULL DEFAULT 0,
  cache_cost_micros BIGINT NOT NULL DEFAULT 0,
  input_sell_micros BIGINT NOT NULL DEFAULT 0,
  output_sell_micros BIGINT NOT NULL DEFAULT 0,
  cache_sell_micros BIGINT NOT NULL DEFAULT 0,
  fixed_cost_micros BIGINT NOT NULL DEFAULT 0,
  fixed_sell_micros BIGINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  -- Explicit aliases document that token values are per-million rates.
  input_cost_micros_per_million BIGINT,
  output_cost_micros_per_million BIGINT,
  cache_cost_micros_per_million BIGINT,
  input_sell_micros_per_million BIGINT,
  output_sell_micros_per_million BIGINT,
  cache_sell_micros_per_million BIGINT,
  price_source TEXT,
  price_effective_at TIMESTAMPTZ,
  fx_rate_cny_micros BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(trim(model_pattern)) BETWEEN 1 AND 256),
  CHECK (input_cost_micros >= 0 AND output_cost_micros >= 0 AND cache_cost_micros >= 0),
  CHECK (input_sell_micros >= 0 AND output_sell_micros >= 0 AND cache_sell_micros >= 0),
  CHECK (fixed_cost_micros >= 0 AND fixed_sell_micros >= 0),
  CHECK (input_cost_micros_per_million IS NULL OR input_cost_micros_per_million >= 0),
  CHECK (output_cost_micros_per_million IS NULL OR output_cost_micros_per_million >= 0),
  CHECK (cache_cost_micros_per_million IS NULL OR cache_cost_micros_per_million >= 0),
  CHECK (input_sell_micros_per_million IS NULL OR input_sell_micros_per_million >= 0),
  CHECK (output_sell_micros_per_million IS NULL OR output_sell_micros_per_million >= 0),
  CHECK (cache_sell_micros_per_million IS NULL OR cache_sell_micros_per_million >= 0)
  ,CHECK (fx_rate_cny_micros IS NULL OR fx_rate_cny_micros > 0)
);
CREATE INDEX IF NOT EXISTS model_prices_active_lookup_idx ON model_prices (active, model_pattern);
CREATE UNIQUE INDEX IF NOT EXISTS model_prices_pattern_unique ON model_prices (model_pattern);

CREATE TABLE IF NOT EXISTS fixed_route_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  http_method TEXT NOT NULL DEFAULT 'ANY',
  path_pattern TEXT NOT NULL,
  requested_model TEXT,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  sell_micros BIGINT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  match_priority INTEGER NOT NULL DEFAULT 100,
  selectors JSONB NOT NULL DEFAULT '{}'::jsonb,
  unit_path TEXT,
  unit_mode TEXT NOT NULL DEFAULT 'request',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (http_method IN ('ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
  CHECK (path_pattern LIKE '/%'),
  CHECK (requested_model IS NULL OR char_length(trim(requested_model)) BETWEEN 1 AND 256),
  CHECK (cost_micros >= 0 AND sell_micros >= 0),
  CHECK (match_priority >= 0)
  ,CHECK (unit_mode IN ('request', 'count', 'seconds'))
);
CREATE UNIQUE INDEX IF NOT EXISTS fixed_route_prices_match_unique
  ON fixed_route_prices (http_method, path_pattern, (COALESCE(requested_model, '')));
CREATE INDEX IF NOT EXISTS fixed_route_prices_lookup_idx
  ON fixed_route_prices (enabled, http_method, path_pattern, match_priority ASC, id ASC);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no TEXT NOT NULL DEFAULT ('RS' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL DEFAULT 'wallet_topup',
  order_type TEXT NOT NULL DEFAULT 'wallet_topup',
  plan_id UUID REFERENCES plans(id) ON DELETE RESTRICT,
  -- Immutable commercial terms captured when a subscription order is created.
  -- Settlement must not depend on a later admin edit to `plans`.
  plan_name_snapshot TEXT,
  plan_quota_micros BIGINT,
  plan_duration_days SMALLINT,
  amount_micros BIGINT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'wechat',
  payment_provider TEXT NOT NULL DEFAULT 'wechat_native',
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'pending',
  provider_order_id TEXT,
  provider_trade_id TEXT,
  qr_code_url TEXT,
  paid_amount_micros BIGINT,
  expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  failure_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(trim(order_no)) BETWEEN 8 AND 128),
  CHECK (kind IN ('wallet_topup', 'subscription', 'subscription_purchase')),
  CHECK (order_type IN ('wallet_topup', 'subscription', 'subscription_purchase')),
  CHECK (amount_micros > 0),
  CHECK (payment_method IN ('wechat', 'alipay', 'wechat_native', 'alipay_precreate')),
  CHECK (payment_provider IN ('wechat', 'alipay', 'wechat_native', 'alipay_precreate')),
  CHECK (currency = 'CNY'),
  CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'closed')),
  CHECK (paid_amount_micros IS NULL OR paid_amount_micros > 0),
  CHECK ((kind IN ('subscription', 'subscription_purchase')) = (plan_id IS NOT NULL)),
  CHECK (plan_quota_micros IS NULL OR plan_quota_micros > 0),
  CHECK (plan_duration_days IS NULL OR plan_duration_days = 30),
  CHECK (paid_at IS NULL OR status = 'paid')
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_order_no_unique ON orders (order_no);
CREATE UNIQUE INDEX IF NOT EXISTS orders_provider_order_unique ON orders (payment_provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_provider_trade_unique ON orders (payment_provider, provider_trade_id) WHERE provider_trade_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_user_cursor_idx ON orders (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_status_expiry_idx ON orders (status, expires_at, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  order_id UUID REFERENCES orders(id) ON DELETE RESTRICT,
  provider_transaction_id TEXT,
  event_type TEXT NOT NULL DEFAULT 'payment_notify',
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  amount_micros BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (provider IN ('wechat', 'alipay', 'wechat_native', 'alipay_precreate')),
  CHECK (char_length(trim(event_id)) BETWEEN 1 AND 256),
  CHECK (amount_micros IS NULL OR amount_micros > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_events_provider_event_unique ON payment_events (provider, event_id);
CREATE INDEX IF NOT EXISTS payment_events_order_cursor_idx ON payment_events (order_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS payment_events_transaction_idx ON payment_events (provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscription_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  plan_name_snapshot TEXT NOT NULL,
  quota_added_micros BIGINT NOT NULL,
  amount_paid_micros BIGINT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (quota_added_micros > 0 AND amount_paid_micros > 0),
  CHECK (expires_at > starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_purchases_order_unique ON subscription_purchases (order_id);
CREATE INDEX IF NOT EXISTS subscription_purchases_user_cursor_idx ON subscription_purchases (subscription_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS usage_logs (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  api_key_name_snapshot TEXT,
  requested_model TEXT NOT NULL DEFAULT '',
  upstream_model TEXT NOT NULL DEFAULT '',
  final_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  final_channel_name_snapshot TEXT,
  request_path TEXT NOT NULL DEFAULT '/v1/chat/completions',
  request_method TEXT NOT NULL DEFAULT 'POST',
  billing_mode TEXT NOT NULL DEFAULT 'token',
  pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_tokens BIGINT NOT NULL DEFAULT 0,
  reported_total_tokens BIGINT NOT NULL DEFAULT 0,
  plan_charge_micros BIGINT NOT NULL DEFAULT 0,
  wallet_charge_micros BIGINT NOT NULL DEFAULT 0,
  charge_micros BIGINT NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  profit_micros BIGINT NOT NULL DEFAULT 0,
  status_code INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  success BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  estimated_usage BOOLEAN NOT NULL DEFAULT FALSE,
  is_estimated_usage BOOLEAN NOT NULL DEFAULT FALSE,
  error_code TEXT,
  error_summary TEXT,
  upstream_request_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (request_path LIKE '/v1/%'),
  CHECK (request_method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
  CHECK (billing_mode IN ('token', 'fixed', 'free')),
  CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cache_tokens >= 0 AND reported_total_tokens >= 0),
  CHECK (plan_charge_micros >= 0 AND wallet_charge_micros >= 0 AND charge_micros >= 0 AND cost_micros >= 0),
  CHECK (charge_micros = plan_charge_micros + wallet_charge_micros),
  CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  CHECK (status IN ('pending', 'success', 'failed', 'canceled', 'rejected')),
  CHECK (latency_ms >= 0 AND (duration_ms IS NULL OR duration_ms >= 0)),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK (error_summary IS NULL OR char_length(error_summary) <= 1000)
);
CREATE INDEX IF NOT EXISTS usage_logs_user_cursor_idx ON usage_logs (user_id, created_at DESC, id DESC);
-- The user API orders by request_id as its stable cursor tie-breaker. Keep a
-- matching index instead of relying on the identity column index above.
CREATE INDEX IF NOT EXISTS usage_logs_user_request_cursor_idx
  ON usage_logs (user_id, created_at DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS usage_logs_user_status_cursor_idx ON usage_logs (user_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS usage_logs_user_model_cursor_idx ON usage_logs (user_id, requested_model, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS usage_logs_user_key_cursor_idx ON usage_logs (user_id, key_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS usage_logs_admin_cursor_idx ON usage_logs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS usage_logs_channel_cursor_idx ON usage_logs (final_channel_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS relay_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES usage_logs(request_id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  channel_name_snapshot TEXT,
  attempt_no INTEGER NOT NULL,
  attempt_number INTEGER,
  upstream_model TEXT,
  status_code INTEGER,
  outcome TEXT NOT NULL DEFAULT 'client_error',
  error_type TEXT,
  error_message TEXT,
  error_code TEXT,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  cost_estimated BOOLEAN NOT NULL DEFAULT TRUE,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  is_final BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (attempt_no > 0),
  CHECK (attempt_number IS NULL OR attempt_number > 0),
  CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  CHECK (cost_micros >= 0),
  CHECK (latency_ms >= 0 AND (duration_ms IS NULL OR duration_ms >= 0)),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK (outcome IN ('success', 'network_error', 'timeout', 'rate_limited', 'server_error', 'client_error', 'canceled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS relay_attempts_request_no_unique ON relay_attempts (request_id, attempt_no);
CREATE UNIQUE INDEX IF NOT EXISTS relay_attempts_request_final_unique ON relay_attempts (request_id) WHERE is_final;
CREATE INDEX IF NOT EXISTS relay_attempts_channel_cursor_idx ON relay_attempts (channel_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS billing_reservations (
  -- A reservation is intentionally allowed before usage_logs is inserted: the
  -- relay reserves funds at request start and writes the final usage row only
  -- after the upstream response is known.
  request_id UUID PRIMARY KEY,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  estimated_micros BIGINT NOT NULL DEFAULT 0,
  estimated_charge_micros BIGINT,
  plan_reserved_micros BIGINT NOT NULL DEFAULT 0,
  wallet_reserved_micros BIGINT NOT NULL DEFAULT 0,
  actual_micros BIGINT,
  plan_settled_micros BIGINT,
  wallet_settled_micros BIGINT,
  status TEXT NOT NULL DEFAULT 'reserved',
  pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  settled_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (estimated_micros >= 0),
  CHECK (estimated_charge_micros IS NULL OR estimated_charge_micros >= 0),
  CHECK (plan_reserved_micros >= 0 AND wallet_reserved_micros >= 0),
  CONSTRAINT billing_reservations_allocation_check CHECK (plan_reserved_micros + wallet_reserved_micros = estimated_micros),
  CHECK (actual_micros IS NULL OR actual_micros >= 0),
  CHECK (plan_settled_micros IS NULL OR plan_settled_micros >= 0),
  CHECK (wallet_settled_micros IS NULL OR wallet_settled_micros >= 0),
  CHECK (status IN ('reserved', 'settled', 'released', 'expired')),
  CHECK (expires_at > reserved_at),
  CHECK (settled_at IS NULL OR status = 'settled'),
  CHECK (released_at IS NULL OR status IN ('released', 'expired')),
  CONSTRAINT billing_reservations_settlement_check CHECK (
    status <> 'settled' OR (
      actual_micros IS NOT NULL AND plan_settled_micros IS NOT NULL AND wallet_settled_micros IS NOT NULL
      AND plan_settled_micros + wallet_settled_micros = actual_micros
    )
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_reservations_id_unique ON billing_reservations (id);
CREATE INDEX IF NOT EXISTS billing_reservations_expiry_idx ON billing_reservations (status, expires_at);
CREATE INDEX IF NOT EXISTS billing_reservations_user_cursor_idx ON billing_reservations (user_id, created_at DESC, request_id DESC);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  entry_kind TEXT,
  amount_micros BIGINT NOT NULL DEFAULT 0,
  balance_after_micros BIGINT NOT NULL DEFAULT 0,
  reserved_delta_micros BIGINT NOT NULL DEFAULT 0,
  order_id UUID REFERENCES orders(id) ON DELETE RESTRICT,
  request_id UUID,
  affiliate_conversion_id UUID,
  reference_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wallet_ledger_kind_check CHECK (kind IN ('wallet_topup', 'plan_reserve', 'reserve', 'usage_reserve', 'usage_settle', 'usage_release', 'refund_reserve', 'affiliate_conversion', 'affiliate_convert', 'admin_adjustment', 'payment_reversal')),
  CHECK (amount_micros <> 0 OR reserved_delta_micros <> 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_topup_order_unique ON wallet_ledger (order_id) WHERE kind = 'wallet_topup';
CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_affiliate_conversion_unique ON wallet_ledger (affiliate_conversion_id) WHERE affiliate_conversion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_ledger_user_cursor_idx ON wallet_ledger (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS wallet_ledger_request_idx ON wallet_ledger (request_id, id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscription_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  remaining_delta_micros BIGINT NOT NULL DEFAULT 0,
  reserved_delta_micros BIGINT NOT NULL DEFAULT 0,
  order_id UUID REFERENCES orders(id) ON DELETE RESTRICT,
  request_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind IN ('purchase_credit', 'plan_reserve', 'usage_reserve', 'usage_settle', 'usage_release', 'expiry_forfeit', 'admin_adjustment')),
  CHECK (remaining_delta_micros <> 0 OR reserved_delta_micros <> 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_ledger_purchase_order_unique ON subscription_ledger (order_id) WHERE kind = 'purchase_credit';
CREATE INDEX IF NOT EXISTS subscription_ledger_subscription_cursor_idx ON subscription_ledger (subscription_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS subscription_ledger_request_idx ON subscription_ledger (request_id, id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  inviter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  invited_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  invitee_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  paid_amount_micros BIGINT NOT NULL,
  payment_amount_micros BIGINT,
  rate_bps INTEGER NOT NULL,
  commission_micros BIGINT NOT NULL,
  reward_micros BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (invited_user_id IS NOT NULL OR invitee_user_id IS NOT NULL),
  CHECK (inviter_user_id <> COALESCE(invited_user_id, invitee_user_id)),
  CHECK (paid_amount_micros > 0),
  CHECK (payment_amount_micros IS NULL OR payment_amount_micros > 0),
  CHECK (rate_bps BETWEEN 0 AND 10000),
  CHECK (commission_micros >= 0),
  CHECK (reward_micros IS NULL OR reward_micros >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_commissions_order_unique ON affiliate_commissions (order_id);
CREATE INDEX IF NOT EXISTS affiliate_commissions_inviter_cursor_idx ON affiliate_commissions (inviter_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS affiliate_commissions_invitee_cursor_idx ON affiliate_commissions (invited_user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS affiliate_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_micros BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount_micros > 0)
);
CREATE INDEX IF NOT EXISTS affiliate_conversions_user_cursor_idx ON affiliate_conversions (user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS affiliate_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  amount_micros BIGINT NOT NULL,
  balance_after_micros BIGINT NOT NULL DEFAULT 0,
  commission_id UUID REFERENCES affiliate_commissions(id) ON DELETE RESTRICT,
  conversion_id UUID REFERENCES affiliate_conversions(id) ON DELETE RESTRICT,
  order_id UUID REFERENCES orders(id) ON DELETE RESTRICT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_ledger_kind_check CHECK (kind IN ('commission_credit', 'commission', 'conversion_debit', 'convert', 'admin_adjustment', 'reversal')),
  CHECK (amount_micros <> 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_ledger_commission_unique ON affiliate_ledger (commission_id) WHERE commission_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_ledger_conversion_unique ON affiliate_ledger (conversion_id) WHERE conversion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS affiliate_ledger_user_cursor_idx ON affiliate_ledger (user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  setting_key TEXT UNIQUE,
  value TEXT NOT NULL,
  value_json JSONB,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_events_target_cursor_idx ON admin_audit_events (target_type, target_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_audit_events_actor_cursor_idx ON admin_audit_events (actor_user_id, created_at DESC, id DESC);

-- PostgreSQL has no CREATE TRIGGER IF NOT EXISTS, so trigger creation is guarded.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_set_updated_at' AND tgrelid = 'users'::regclass) THEN
    CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_prevent_invite_code_change' AND tgrelid = 'users'::regclass) THEN
    CREATE TRIGGER users_prevent_invite_code_change BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION relay_prevent_invite_code_change();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'wallets_set_updated_at' AND tgrelid = 'wallets'::regclass) THEN
    CREATE TRIGGER wallets_set_updated_at BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_wallets_set_updated_at' AND tgrelid = 'affiliate_wallets'::regclass) THEN
    CREATE TRIGGER affiliate_wallets_set_updated_at BEFORE UPDATE ON affiliate_wallets FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'plans_set_updated_at' AND tgrelid = 'plans'::regclass) THEN
    CREATE TRIGGER plans_set_updated_at BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'subscriptions_set_updated_at' AND tgrelid = 'subscriptions'::regclass) THEN
    CREATE TRIGGER subscriptions_set_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'channels_set_updated_at' AND tgrelid = 'channels'::regclass) THEN
    CREATE TRIGGER channels_set_updated_at BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'channel_model_mappings_set_updated_at' AND tgrelid = 'channel_model_mappings'::regclass) THEN
    CREATE TRIGGER channel_model_mappings_set_updated_at BEFORE UPDATE ON channel_model_mappings FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'model_prices_set_updated_at' AND tgrelid = 'model_prices'::regclass) THEN
    CREATE TRIGGER model_prices_set_updated_at BEFORE UPDATE ON model_prices FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'fixed_route_prices_set_updated_at' AND tgrelid = 'fixed_route_prices'::regclass) THEN
    CREATE TRIGGER fixed_route_prices_set_updated_at BEFORE UPDATE ON fixed_route_prices FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'orders_set_updated_at' AND tgrelid = 'orders'::regclass) THEN
    CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'orders_sync_aliases' AND tgrelid = 'orders'::regclass) THEN
    CREATE TRIGGER orders_sync_aliases BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION relay_sync_order_aliases();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_commissions_sync_aliases' AND tgrelid = 'affiliate_commissions'::regclass) THEN
    CREATE TRIGGER affiliate_commissions_sync_aliases BEFORE INSERT OR UPDATE ON affiliate_commissions FOR EACH ROW EXECUTE FUNCTION relay_sync_affiliate_aliases();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'billing_reservations_set_updated_at' AND tgrelid = 'billing_reservations'::regclass) THEN
    CREATE TRIGGER billing_reservations_set_updated_at BEFORE UPDATE ON billing_reservations FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'app_settings_set_updated_at' AND tgrelid = 'app_settings'::regclass) THEN
    CREATE TRIGGER app_settings_set_updated_at BEFORE UPDATE ON app_settings FOR EACH ROW EXECUTE FUNCTION relay_set_updated_at();
  END IF;
END
$$;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['invitation_bindings', 'payment_events', 'subscription_purchases', 'wallet_ledger', 'subscription_ledger', 'affiliate_commissions', 'affiliate_conversions', 'affiliate_ledger', 'admin_audit_events'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = table_name || '_immutable' AND tgrelid = table_name::regclass) THEN
      EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION relay_prevent_immutable_mutation()', table_name, table_name);
    END IF;
  END LOOP;
END
$$;

INSERT INTO app_settings (key, setting_key, value, value_json)
VALUES
  ('affiliate_enabled', 'affiliate.enabled', 'true', 'true'::jsonb),
  ('affiliate_rate_bps', 'affiliate.rate_bps', '1000', '1000'::jsonb),
  ('site_name', 'site.name', 'GPT TOKEN', to_jsonb('GPT TOKEN'::text)),
  ('site_title', 'site.title', 'GPT TOKEN | OpenAI 兼容 API 控制台', to_jsonb('GPT TOKEN | OpenAI 兼容 API 控制台'::text)),
  ('site_logo_url', 'site.logo_url', '/assets/gpt-token-mark-192.png', to_jsonb('/assets/gpt-token-mark-192.png'::text))
ON CONFLICT (key) DO NOTHING;

-- The service is shipped as a fresh surface, but keeping these additive
-- guards makes a partially initialized database recoverable without dropping
-- any immutable accounting history.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS encrypted_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_ci_unique ON users (lower(email)) WHERE email IS NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plan_name_snapshot TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plan_quota_micros BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plan_duration_days SMALLINT;

-- Normalize rows written by the early compatibility API before using `kind`
-- for settlement dispatch.  The trigger keeps new writes canonical, but it
-- cannot repair rows that already existed when the trigger was introduced.
UPDATE orders
SET kind = order_type
WHERE kind = 'wallet_topup' AND order_type IN ('subscription', 'subscription_purchase');
UPDATE orders
SET order_type = kind
WHERE order_type = 'wallet_topup' AND kind IN ('subscription', 'subscription_purchase');

-- Orders created before subscription snapshots were introduced do not have a
-- trustworthy copy of their commercial terms.  Backfill only the legacy
-- pending rows whose amount still matches the current plan and whose plan
-- configuration is valid.  Mismatched rows intentionally remain incomplete
-- so payment settlement stops for manual review instead of granting a
-- silently changed quota.
UPDATE orders AS o
SET plan_name_snapshot = left(trim(p.name), 128),
    plan_quota_micros = p.quota_micros,
    plan_duration_days = p.duration_days
FROM plans AS p
WHERE o.plan_id = p.id
  AND o.kind IN ('subscription', 'subscription_purchase')
  AND o.status = 'pending'
  AND o.plan_name_snapshot IS NULL
  AND o.plan_quota_micros IS NULL
  AND o.plan_duration_days IS NULL
  AND p.price_micros = o.amount_micros
  AND p.quota_micros > 0
  AND p.duration_days = 30;

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS reserved_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reserved_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE billing_reservations ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE billing_reservations ADD COLUMN IF NOT EXISTS estimated_charge_micros BIGINT;
ALTER TABLE billing_reservations ADD COLUMN IF NOT EXISTS actual_micros BIGINT;
ALTER TABLE billing_reservations ADD COLUMN IF NOT EXISTS plan_settled_micros BIGINT;
ALTER TABLE fixed_route_prices ADD COLUMN IF NOT EXISTS selectors JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE fixed_route_prices ADD COLUMN IF NOT EXISTS unit_path TEXT;
ALTER TABLE fixed_route_prices ADD COLUMN IF NOT EXISTS unit_mode TEXT NOT NULL DEFAULT 'request';
ALTER TABLE model_prices ADD COLUMN IF NOT EXISTS price_source TEXT;
ALTER TABLE model_prices ADD COLUMN IF NOT EXISTS price_effective_at TIMESTAMPTZ;
ALTER TABLE model_prices ADD COLUMN IF NOT EXISTS fx_rate_cny_micros BIGINT;
ALTER TABLE billing_reservations ADD COLUMN IF NOT EXISTS wallet_settled_micros BIGINT;
ALTER TABLE billing_reservations ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE billing_reservations ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE billing_reservations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes');
ALTER TABLE billing_reservations ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE wallet_ledger ADD COLUMN IF NOT EXISTS reserved_delta_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE subscription_ledger ADD COLUMN IF NOT EXISTS reserved_delta_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_reserved_within_balance;
ALTER TABLE wallets ADD CONSTRAINT wallets_reserved_within_balance CHECK (reserved_micros <= balance_micros);
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_reserved_within_remaining;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_reserved_within_remaining CHECK (reserved_micros <= remaining_micros);
ALTER TABLE billing_reservations DROP CONSTRAINT IF EXISTS billing_reservations_allocation_check;
ALTER TABLE billing_reservations ADD CONSTRAINT billing_reservations_allocation_check
  CHECK (plan_reserved_micros + wallet_reserved_micros = estimated_micros);
ALTER TABLE billing_reservations DROP CONSTRAINT IF EXISTS billing_reservations_settlement_check;
ALTER TABLE billing_reservations ADD CONSTRAINT billing_reservations_settlement_check CHECK (
  status <> 'settled' OR (
    actual_micros IS NOT NULL AND plan_settled_micros IS NOT NULL AND wallet_settled_micros IS NOT NULL
    AND plan_settled_micros + wallet_settled_micros = actual_micros
  )
);
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS api_key_name_snapshot TEXT;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS final_channel_name_snapshot TEXT;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS request_path TEXT NOT NULL DEFAULT '/v1/chat/completions';
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS request_method TEXT NOT NULL DEFAULT 'POST';
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'token';
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS is_estimated_usage BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS error_summary TEXT;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS upstream_request_id TEXT;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE relay_attempts ADD COLUMN IF NOT EXISTS cost_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_attempts ADD COLUMN IF NOT EXISTS cost_estimated BOOLEAN NOT NULL DEFAULT TRUE;

-- Usage APIs page by request start time, not settlement time.  Keep these
-- separate from the original created_at indexes so an existing deployment
-- can add the new access paths without rebuilding an immutable audit table.
CREATE INDEX IF NOT EXISTS usage_logs_user_started_request_cursor_idx
  ON usage_logs (user_id, started_at DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS usage_logs_user_status_started_cursor_idx
  ON usage_logs (user_id, status, started_at DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS usage_logs_user_model_started_cursor_idx
  ON usage_logs (user_id, requested_model, started_at DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS usage_logs_user_key_started_cursor_idx
  ON usage_logs (user_id, (COALESCE(api_key_id, key_id)), started_at DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS usage_logs_admin_started_cursor_idx
  ON usage_logs (started_at DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS usage_logs_channel_started_cursor_idx
  ON usage_logs (final_channel_id, started_at DESC, request_id DESC);

-- Early relay-station schema revisions used narrower ledger vocabularies.
-- Replace those checks in-place so an already initialized database accepts
-- the service's canonical `commission`, `convert`, and `affiliate_convert`
-- entries without touching immutable ledger rows.
ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_kind_check;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_kind_check
  CHECK (kind IN ('wallet_topup', 'plan_reserve', 'reserve', 'usage_reserve', 'usage_settle', 'usage_release', 'refund_reserve', 'affiliate_conversion', 'affiliate_convert', 'admin_adjustment', 'payment_reversal'));
ALTER TABLE affiliate_ledger DROP CONSTRAINT IF EXISTS affiliate_ledger_kind_check;
ALTER TABLE affiliate_ledger ADD CONSTRAINT affiliate_ledger_kind_check
  CHECK (kind IN ('commission_credit', 'commission', 'conversion_debit', 'convert', 'admin_adjustment', 'reversal'));
