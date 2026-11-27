-- =============================================================
-- Aegis Rover Command - Supabase Schema
-- Tables: telemetry_logs, safety_alerts, device_nodes, vision_snapshots
-- =============================================================

-- ─────────────────────────────────────────────
-- 1. TELEMETRY LOGS
--    Stores every sensor reading + car movement
--    (direction: FORWARD/REVERSE/STEER_L/STEER_R/IDLE, speed A & B)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.telemetry_logs (
    id               BIGSERIAL PRIMARY KEY,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Identity
    device_id        TEXT        NOT NULL,          -- e.g. "GLOVEDRIVE-ESP32-01"
    mode             TEXT        NOT NULL DEFAULT 'LIVE',

    -- Car movement
    command          TEXT,                           -- glove command  (FORWARD/REVERSE/STEER_L/STEER_R/IDLE)
    direction        TEXT,                           -- actual motor direction
    speed_a          INT         DEFAULT 0,          -- motor-A PWM 0-100%
    speed_b          INT         DEFAULT 0,          -- motor-B PWM 0-100%

    -- Control state
    control_lock     TEXT,                           -- "GLOVE_ESPNOW" | "HUB_ESTOP"
    emergency_stop   BOOLEAN     NOT NULL DEFAULT FALSE,

    -- Actuator & range configuration
    servo_angle      INT         DEFAULT 90,
    stop_cm          INT         DEFAULT 20,

    -- Distance sensor (ultrasonic)
    front_dist_cm    INT,                            -- 999 = no reading

    -- Environment sensors (DHT11 + MQ gas)
    temp_c           FLOAT,
    humidity_pct     FLOAT,
    gas_raw          INT,

    -- Link quality
    rssi_dbm         INT,

    -- Computed scores
    hazard_score     INT,                            -- 0-100
    person_detected  BOOLEAN     NOT NULL DEFAULT FALSE
);

-- Index: fast time-range queries for the analytics charts
CREATE INDEX IF NOT EXISTS idx_telemetry_device_time
    ON public.telemetry_logs (device_id, created_at DESC);


-- ─────────────────────────────────────────────
-- 2. SAFETY ALERTS
--    Stores gas, sonar, link, and e-stop events
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.safety_alerts (
    id               BIGSERIAL PRIMARY KEY,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    device_id        TEXT        NOT NULL,
    source           TEXT        NOT NULL,           -- "GAS" | "SONAR" | "LINK" | "E-STOP"
    severity         TEXT        NOT NULL,           -- "ELEVATED" | "CRITICAL"
    message          TEXT        NOT NULL,
    command          TEXT,
    hazard_score     INT,
    emergency_stop   BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_alerts_device_time
    ON public.safety_alerts (device_id, created_at DESC);


-- ─────────────────────────────────────────────
-- 3. DEVICE NODES
--    One row per ESP node (upserted every 5 s)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.device_nodes (
    node_id      TEXT PRIMARY KEY,                   -- "glove" | "main" | "cam"
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    title        TEXT,
    proto        TEXT,
    ip           TEXT,
    status       TEXT,                               -- "ONLINE" | "SILENT" | "OFFLINE"
    latency_ms   INT,
    packet_rate  INT,
    signal       TEXT                                -- e.g. "-65 dBm"
);


-- ─────────────────────────────────────────────
-- 4. VISION SNAPSHOTS
--    Camera frames: stores JPEG bytes + metadata.
--    image_data  holds the raw JPEG as bytea.
--    image_url   is an alternative if you upload to Supabase Storage
--    and only keep the public URL here.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vision_snapshots (
    id               BIGSERIAL PRIMARY KEY,
    captured_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- timestamp of the frame

    device_id        TEXT        NOT NULL,
    fps              INT,
    person_detected  BOOLEAN     NOT NULL DEFAULT FALSE,
    confidence       FLOAT       DEFAULT 0.0,
    hazard_score     INT         DEFAULT 0,

    -- Store image: pick ONE strategy
    image_data       BYTEA,                               -- raw JPEG bytes (inline)
    image_url        TEXT,                                -- OR Supabase Storage public URL
    image_size_bytes INT
);

CREATE INDEX IF NOT EXISTS idx_vision_device_time
    ON public.vision_snapshots (device_id, captured_at DESC);


-- ─────────────────────────────────────────────
-- 5. VEHICLE SESSIONS
--    Stores every Car ON/OFF session, duration,
--    aggregated telemetry, and timeline samples
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vehicle_sessions (
    id                BIGSERIAL PRIMARY KEY,
    session_uid       TEXT             UNIQUE NOT NULL,
    device_id         TEXT             NOT NULL,
    started_at        TIMESTAMPTZ      NOT NULL,
    ended_at          TIMESTAMPTZ,
    duration_s        DOUBLE PRECISION NOT NULL DEFAULT 0,
    is_active         BOOLEAN          NOT NULL DEFAULT TRUE,
    on_reason         TEXT             DEFAULT 'ESP32 Car Connected',
    off_reason        TEXT,
    telemetry_summary JSONB            NOT NULL DEFAULT '{}'::jsonb,
    telemetry_samples JSONB            NOT NULL DEFAULT '[]'::jsonb,
    updated_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_device_started
    ON public.vehicle_sessions (device_id, started_at DESC);


-- ─────────────────────────────────────────────
-- Row-Level Security: open for server-side use
-- (enable RLS if you expose these to a browser client)
-- ─────────────────────────────────────────────
ALTER TABLE public.telemetry_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_alerts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_nodes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vision_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_sessions  ENABLE ROW LEVEL SECURITY;

-- Allow the service-role key (backend) full access
-- (drop first so the script is re-runnable)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='service_all_telemetry' AND tablename='telemetry_logs') THEN
    CREATE POLICY "service_all_telemetry" ON public.telemetry_logs FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='service_all_alerts' AND tablename='safety_alerts') THEN
    CREATE POLICY "service_all_alerts" ON public.safety_alerts FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='service_all_nodes' AND tablename='device_nodes') THEN
    CREATE POLICY "service_all_nodes" ON public.device_nodes FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='service_all_vision' AND tablename='vision_snapshots') THEN
    CREATE POLICY "service_all_vision" ON public.vision_snapshots FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='service_all_sessions' AND tablename='vehicle_sessions') THEN
    CREATE POLICY "service_all_sessions" ON public.vehicle_sessions FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
