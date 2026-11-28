"""Aegis Rover Command - FastAPI backend.
ESPs  -> ws://<laptop>:8000/ws/<main|glove|cam>      (same JSON protocol as before)
Browser-> http://localhost:8000  (dashboard)  +  ws://localhost:8000/ws/dashboard
Data   -> Supabase tables telemetry_logs, safety_alerts, device_nodes, vision_snapshots (batched, retried)."""
import asyncio, contextlib, hashlib, hmac, html, json, os, re, secrets, sqlite3, tempfile, time, urllib.error, urllib.parse, urllib.request, uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

import asyncpg
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / "config" / ".env", override=True)
E = os.getenv
START_TIME = time.time()
DB_URL = E("DATABASE_URL", "")
UNIT = E("UNIT_ID", "GLOVEDRIVE-ESP32-01")
CAMERA_STREAM_URL = E("CAMERA_STREAM_URL", "")
GOOGLE_CLIENT_ID = E("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_GEOLOCATION_API_KEY = (
    E("GOOGLE_GEOLOCATION_API_KEY", "").strip()
    or E("VITE_GOOGLE_MAPS_API_KEY", "").strip()
)
LOCATION_STALE_S = float(E("LOCATION_STALE_S", 90))
LOCATION_MIN_INTERVAL_S = float(E("LOCATION_MIN_INTERVAL_S", 12))
RESEND_API_KEY = E("RESEND_API_KEY", "").strip()
EMAIL_FROM = E("EMAIL_FROM", "").strip()
AUTH_SESSION_TTL_S = int(E("AUTH_SESSION_TTL_S", 7 * 24 * 3600))
OTP_TTL_S = 600
OTP_RESEND_COOLDOWN_S = 30
AUTH_COOKIE_NAME = "aegis_session"
GAS_WARN, GAS_DANGER = int(E("GAS_WARN_RAW", 1500)), int(E("GAS_DANGER_RAW", 2500))
RSSI_MIN, SILENT_S = int(E("RSSI_MIN_DBM", -80)), float(E("SILENT_AFTER_S", 3))
LOG_S, CAM_S = float(E("DB_LOG_INTERVAL_S", 1)), float(E("CAM_POLL_INTERVAL_S", 1))
COOLDOWN_S = float(E("ALERT_COOLDOWN_S", 30))
NODES = {"glove": ("ESP32 Glove", "ESP-NOW + WS"), "main": ("ESP32 Car", "WebSocket"),
         "cam": ("ESP32-CAM Vision", "HTTP + WS")}
DIRS = {"F": "FORWARD", "B": "REVERSE", "L": "STEER_L", "R": "STEER_R", "S": "IDLE"}
TABLES = {"telemetry_logs", "safety_alerts", "vision_snapshots"}

devs = {k: dict(ws=None, ip=None, last=0.0, seq=None, lost=0, rssi=None, rtt=None, data={},
                arr=deque(maxlen=200), conns=0, pings={}, n=0) for k in NODES}
hist = deque(maxlen=600)          # in-memory points for the analytics charts
alerts = deque(maxlen=60)
pending = deque(maxlen=20000)     # (table, row) waiting for Supabase
db = {"pool": None, "ok": False, "records": 0, "schema_ready": False}
cool, state = {}, {"estop": False, "prev": (60, 60), "jpg": None, "jpg_t": 0, "alert_seq": 0}
_MAC_RE = re.compile(r"^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$")
location_state = {
    "lat": None,
    "lng": None,
    "accuracy_m": None,
    "ap_count": 0,
    "updated_at": None,
    "last_scan_at": None,
    "last_api_t": 0.0,
    "resolving": False,
    "error": None,
}
SESSION_DB_PATH = None
session_sync_queue = deque(maxlen=500)
active_session = None
_pg_lock = None
app = FastAPI(title="Aegis Rover Command")


@app.exception_handler(HTTPException)
async def _http_exc_handler(request: Request, exc: HTTPException):
    resp = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    if exc.status_code == 401:
        resp.delete_cookie(AUTH_COOKIE_NAME, path="/")
    return resp

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static assets (css/, js/) from the static directory
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/css", StaticFiles(directory=str(STATIC_DIR / "css")), name="css")
app.mount("/js",  StaticFiles(directory=str(STATIC_DIR / "js")),  name="js")


def status(d):
    if d["ws"] is None: return "OFFLINE"
    return "ONLINE" if time.time() - d["last"] <= SILENT_S else "SILENT"


def rate(d):
    now = time.time()
    return round(sum(1 for t in d["arr"] if now - t <= 5) / 5, 1)


def alert(key, severity, source, message, command=None, hz=None):
    if time.time() - cool.get(key, 0) < COOLDOWN_S: return
    cool[key] = time.time()
    state["alert_seq"] += 1
    row = dict(device_id=UNIT, source=source, severity=severity, message=message, command=command,
               hazard_score=hz, emergency_stop=state["estop"])
    now_t = time.time()
    alerts.appendleft({**row, "id": state["alert_seq"], "acked": False, "t": now_t})
    pending.append(("safety_alerts", row))
    if active_session is not None:
        s_alerts = active_session["summary"].setdefault("alerts", [])
        if len(s_alerts) < 60:
            s_alerts.append({"t": now_t, "severity": severity, "source": source, "message": message})


def hazard():
    m = devs["main"]["data"]
    if not m: return 0
    gas = min(100, int(m.get("gas_raw", 0) * 100 / 4095))
    dist = m.get("distance_cm", 999)
    near = max(0, min(100, int((80 - dist) * 100 / 80))) if dist < 999 else 0
    return max(gas, near)


def telemetry():
    m, g = devs["main"]["data"], devs["glove"]["data"]
    return dict(device_id=UNIT, mode="LIVE", command=DIRS.get(g.get("command", "S"), "IDLE"),
                control_lock="HUB_ESTOP" if state["estop"] else "GLOVE_ESPNOW",
                direction=DIRS.get(m.get("dir", "S"), "IDLE"),
                speed_a=int(m.get("speedA", 0)),          # motor-A PWM 0-100%
                speed_b=int(m.get("speedB", 0)),          # motor-B PWM 0-100%
                servo_angle=int(m.get("servo", 90) if m.get("servo") is not None else 90),
                stop_cm=int(m.get("stop_cm", 20) if m.get("stop_cm") is not None else 20),
                front_dist_cm=min(int(m.get("distance_cm", 999)), 999),
                temp_c=float(m.get("temp_c") or 0), humidity_pct=float(m.get("hum_pct") or 0),
                gas_raw=int(m.get("gas_raw", 0)), rssi_dbm=int(devs["main"]["rssi"] or 0),
                hazard_score=hazard(), person_detected=False, emergency_stop=state["estop"])


# ---------------- persistent vehicle session tracking ----------------
def _local_tz():
    return datetime.now().astimezone().tzinfo


def _fmt_dt_local(ts: float | None) -> str:
    if ts is None:
        return "--"
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(_local_tz()).strftime("%Y-%m-%d %H:%M:%S")


def _fmt_time_local(ts: float | None) -> str:
    if ts is None:
        return "--"
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(_local_tz()).strftime("%H:%M:%S")


def _fmt_duration(seconds: float) -> str:
    sec = max(0, int(round(seconds or 0)))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h:02d}h {m:02d}m {s:02d}s"
    return f"{m:02d}m {s:02d}s"


def _resolve_session_db_path() -> Path:
    global SESSION_DB_PATH
    if SESSION_DB_PATH is not None:
        return SESSION_DB_PATH
    for p in (
        Path.home() / ".aegis_rover" / "sessions.db",
        Path(tempfile.gettempdir()) / "aegis_rover_sessions.db",
    ):
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "a", encoding="utf-8"):
                pass
            SESSION_DB_PATH = p
            return p
        except OSError:
            continue
    SESSION_DB_PATH = Path(tempfile.gettempdir()) / "aegis_rover_sessions.db"
    return SESSION_DB_PATH


@contextlib.contextmanager
def _sqlite_conn():
    db_file = _resolve_session_db_path()
    conn = sqlite3.connect(str(db_file), timeout=5)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def _init_sqlite():
    try:
        with _sqlite_conn() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS vehicle_sessions (
                    session_uid TEXT PRIMARY KEY,
                    device_id TEXT NOT NULL,
                    started_at REAL NOT NULL,
                    ended_at REAL,
                    duration_s REAL NOT NULL DEFAULT 0,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    on_reason TEXT,
                    off_reason TEXT,
                    telemetry_summary TEXT NOT NULL DEFAULT '{}',
                    telemetry_samples TEXT NOT NULL DEFAULT '[]',
                    updated_at REAL NOT NULL,
                    synced INTEGER NOT NULL DEFAULT 0
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_local_sessions_started ON vehicle_sessions (started_at DESC)")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    user_uid TEXT PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    password_hash TEXT,
                    auth_provider TEXT NOT NULL DEFAULT 'email',
                    google_sub TEXT UNIQUE,
                    avatar_url TEXT,
                    email_verified INTEGER NOT NULL DEFAULT 0,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
            """)
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
            if "is_active" not in cols:
                conn.execute("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS email_otps (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    otp_hash TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    consumed INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_uid TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    revoked INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL
                )
            """)
            # Finalize any active sessions left open from an unclean shutdown
            now = time.time()
            conn.execute("""
                UPDATE vehicle_sessions
                SET is_active = 0,
                    ended_at = COALESCE(ended_at, updated_at, started_at),
                    duration_s = MAX(0, COALESCE(ended_at, updated_at, started_at) - started_at),
                    off_reason = COALESCE(off_reason, 'Server Restarted'),
                    updated_at = ?,
                    synced = 0
                WHERE is_active = 1
            """, (now,))
            conn.commit()
    except Exception as e:
        print("[session-sqlite-init]", type(e).__name__, e)


# ---------------- authentication, OTP & session management ----------------
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _norm_email(email: str) -> str:
    return (email or "").strip().lower()


def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), 210_000)
    return f"pbkdf2_sha256${salt}${dk.hex()}"


def _verify_password(password: str, stored: str | None) -> bool:
    if not stored or "$" not in stored:
        return False
    parts = stored.split("$")
    if len(parts) != 3 or parts[0] != "pbkdf2_sha256":
        return False
    _, salt, expected_hex = parts
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), 210_000)
    return hmac.compare_digest(dk.hex(), expected_hex)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _hash_otp(email: str, otp: str) -> str:
    return hashlib.sha256(f"{_norm_email(email)}:{otp.strip()}".encode("utf-8")).hexdigest()


def _public_user(u: dict) -> dict:
    return {
        "user_uid": u["user_uid"],
        "email": u["email"],
        "name": u["name"],
        "auth_provider": u.get("auth_provider", "email"),
        "avatar_url": u.get("avatar_url"),
        "email_verified": bool(u.get("email_verified")),
        "is_active": bool(u.get("is_active", True)),
    }


async def _get_pg_pool():
    """Return initialized asyncpg pool (creating + migrating schema on demand if DB_URL is set)."""
    global _pg_lock
    if not DB_URL:
        return None
    if db["pool"] is not None and db["schema_ready"]:
        return db["pool"]
    if _pg_lock is None:
        _pg_lock = asyncio.Lock()
    async with _pg_lock:
        if db["pool"] is None:
            db["pool"] = await asyncpg.create_pool(
                DB_URL, ssl="require", min_size=1, max_size=3, statement_cache_size=0
            )
        if not db["schema_ready"]:
            async with db["pool"].acquire() as c:
                await _ensure_db_schema(c)
        return db["pool"]


def _purge_local_user(user_uid: str | None = None, email: str | None = None, token_hash: str | None = None):
    try:
        with _sqlite_conn() as conn:
            if token_hash:
                conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (token_hash,))
            if user_uid:
                conn.execute("DELETE FROM auth_sessions WHERE user_uid = ?", (user_uid,))
                conn.execute("DELETE FROM users WHERE user_uid = ?", (user_uid,))
            if email:
                em = _norm_email(email)
                rows = conn.execute("SELECT user_uid FROM users WHERE email = ?", (em,)).fetchall()
                for r in rows:
                    conn.execute("DELETE FROM auth_sessions WHERE user_uid = ?", (r["user_uid"],))
                conn.execute("DELETE FROM users WHERE email = ?", (em,))
            conn.commit()
    except Exception:
        pass


def _pg_row_to_user(row) -> dict:
    return {
        "user_uid": row["user_uid"],
        "email": row["email"],
        "name": row["name"],
        "password_hash": row["password_hash"],
        "auth_provider": row["auth_provider"],
        "google_sub": row["google_sub"],
        "avatar_url": row["avatar_url"],
        "email_verified": bool(row["email_verified"]),
        "is_active": bool(row["is_active"]) if "is_active" in row else True,
        "created_at": row["created_at"].timestamp() if isinstance(row["created_at"], datetime) else time.time(),
        "updated_at": row["updated_at"].timestamp() if isinstance(row["updated_at"], datetime) else time.time(),
    }


async def _auth_get_user(email: str | None = None, user_uid: str | None = None, google_sub: str | None = None) -> dict | None:
    em = _norm_email(email) if email else None
    # When Supabase is configured, ALWAYS verify user directly in Supabase (never trust stale SQLite)
    if DB_URL:
        try:
            pool = await _get_pg_pool()
            async with pool.acquire() as c:
                row = None
                if user_uid:
                    row = await c.fetchrow("SELECT * FROM public.users WHERE user_uid = $1", user_uid)
                elif google_sub:
                    row = await c.fetchrow("SELECT * FROM public.users WHERE google_sub = $1", google_sub)
                elif em:
                    row = await c.fetchrow("SELECT * FROM public.users WHERE email = $1", em)
                if not row:
                    _purge_local_user(user_uid=user_uid, email=em)
                    return None
                u = _pg_row_to_user(row)
                if not u.get("is_active", True):
                    _purge_local_user(user_uid=u["user_uid"], email=u["email"])
                    return None
                await _auth_save_user(u, sync_pg=False)
                return u
        except Exception as e:
            print("[auth-pg-read]", type(e).__name__, e)
            # Fail closed when Supabase cannot verify
            raise HTTPException(503, "Authentication database unavailable")

    try:
        with _sqlite_conn() as conn:
            row = None
            if user_uid:
                row = conn.execute("SELECT * FROM users WHERE user_uid = ?", (user_uid,)).fetchone()
            elif google_sub:
                row = conn.execute("SELECT * FROM users WHERE google_sub = ?", (google_sub,)).fetchone()
            elif em:
                row = conn.execute("SELECT * FROM users WHERE email = ?", (em,)).fetchone()
            if row:
                u = dict(row)
                if not u.get("is_active", 1):
                    return None
                return u
    except Exception:
        pass
    return None


async def _auth_save_user(u: dict, sync_pg: bool = True):
    now = time.time()
    u.setdefault("created_at", now)
    u.setdefault("is_active", True)
    u["updated_at"] = now
    if sync_pg and DB_URL:
        pool = await _get_pg_pool()
        async with pool.acquire() as c:
            await c.execute("""
                INSERT INTO public.users (user_uid, email, name, password_hash, auth_provider, google_sub, avatar_url, email_verified, is_active, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
                ON CONFLICT (user_uid) DO UPDATE SET
                    email = EXCLUDED.email,
                    name = EXCLUDED.name,
                    password_hash = COALESCE(EXCLUDED.password_hash, public.users.password_hash),
                    auth_provider = EXCLUDED.auth_provider,
                    google_sub = COALESCE(EXCLUDED.google_sub, public.users.google_sub),
                    avatar_url = COALESCE(EXCLUDED.avatar_url, public.users.avatar_url),
                    email_verified = EXCLUDED.email_verified,
                    is_active = EXCLUDED.is_active,
                    updated_at = NOW()
            """,
                u["user_uid"], _norm_email(u["email"]), u["name"], u.get("password_hash"),
                u.get("auth_provider", "email"), u.get("google_sub"), u.get("avatar_url"),
                bool(u.get("email_verified")), bool(u.get("is_active", True)),
            )
    with _sqlite_conn() as conn:
        conn.execute("""
            INSERT INTO users (user_uid, email, name, password_hash, auth_provider, google_sub, avatar_url, email_verified, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_uid) DO UPDATE SET
                email = excluded.email,
                name = excluded.name,
                password_hash = COALESCE(excluded.password_hash, users.password_hash),
                auth_provider = excluded.auth_provider,
                google_sub = COALESCE(excluded.google_sub, users.google_sub),
                avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
                email_verified = excluded.email_verified,
                is_active = excluded.is_active,
                updated_at = excluded.updated_at
        """, (
            u["user_uid"], _norm_email(u["email"]), u["name"], u.get("password_hash"),
            u.get("auth_provider", "email"), u.get("google_sub"), u.get("avatar_url"),
            1 if u.get("email_verified") else 0, 1 if u.get("is_active", True) else 0,
            float(u["created_at"]), float(u["updated_at"]),
        ))
        conn.commit()


def _send_resend_email_sync(to_email: str, name: str, otp: str):
    if not RESEND_API_KEY or not EMAIL_FROM:
        raise HTTPException(500, "Email OTP service is not configured on the server")
    safe_name = html.escape(name or "Operator")
    html_body = f"""
    <div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#060911;color:#f8fafc;padding:28px;border-radius:12px;max-width:480px;margin:auto;border:1px solid #1e293b;">
      <div style="color:#00f0ff;font-size:12px;letter-spacing:2px;font-weight:700;margin-bottom:6px;">GLOVE DRIVE // AEGIS ROVER COMMAND</div>
      <h2 style="margin:0 0 12px 0;font-size:20px;color:#ffffff;">Email Verification Code</h2>
      <p style="color:#94a3b8;font-size:14px;line-height:1.6;">Hi {safe_name},<br>Use the 6-digit verification code below to activate your telemetry dashboard account. This code expires in 10 minutes.</p>
      <div style="margin:22px 0;padding:16px;text-align:center;background:#0a0f1d;border:1px solid rgba(0,240,255,0.35);border-radius:10px;font-family:monospace;font-size:32px;letter-spacing:8px;font-weight:700;color:#00f0ff;">
        {otp}
      </div>
      <p style="color:#64748b;font-size:12px;margin:0;">If you did not request this code, you can safely ignore this email.</p>
    </div>
    """
    payload = json.dumps({
        "from": EMAIL_FROM,
        "to": [to_email],
        "subject": f"Your Aegis Rover verification code: {otp}",
        "html": html_body,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "AegisRoverCommand/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status >= 400:
                raise HTTPException(502, "Failed to send verification email")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            err_json = json.loads(e.read().decode("utf-8", errors="replace"))
            detail = err_json.get("message") or err_json.get("name") or ""
        except Exception:
            pass
        raise HTTPException(502, f"Resend email delivery failed ({e.code}){': ' + detail if detail else ''}")
    except Exception as e:
        raise HTTPException(502, f"Could not reach email service: {type(e).__name__}")


async def _issue_and_send_otp(email: str, name: str, enforce_cooldown: bool = True):
    em = _norm_email(email)
    now = time.time()
    with _sqlite_conn() as conn:
        if enforce_cooldown:
            last = conn.execute(
                "SELECT created_at FROM email_otps WHERE email = ? ORDER BY created_at DESC LIMIT 1",
                (em,),
            ).fetchone()
            if last and (now - float(last["created_at"])) < OTP_RESEND_COOLDOWN_S:
                wait_s = int(OTP_RESEND_COOLDOWN_S - (now - float(last["created_at"]))) + 1
                raise HTTPException(429, f"Please wait {wait_s}s before requesting a new code")

        otp = f"{secrets.randbelow(1_000_000):06d}"
        otp_h = _hash_otp(em, otp)
        exp = now + OTP_TTL_S
        # Send email BEFORE invalidating/persisting so transient failures stay clean
        await asyncio.to_thread(_send_resend_email_sync, em, name, otp)
        conn.execute("UPDATE email_otps SET consumed = 1 WHERE email = ? AND consumed = 0", (em,))
        conn.execute(
            "INSERT INTO email_otps (email, otp_hash, expires_at, attempts, consumed, created_at) VALUES (?, ?, ?, 0, 0, ?)",
            (em, otp_h, exp, now),
        )
        conn.commit()
    if DB_URL:
        try:
            pool = await _get_pg_pool()
            async with pool.acquire() as c:
                await c.execute("UPDATE public.email_otps SET consumed = TRUE WHERE email = $1 AND consumed = FALSE", em)
                await c.execute(
                    "INSERT INTO public.email_otps (email, otp_hash, expires_at, attempts, consumed, created_at) VALUES ($1,$2,$3,0,FALSE,NOW())",
                    em, otp_h, datetime.fromtimestamp(exp, tz=timezone.utc),
                )
        except Exception:
            pass


async def _verify_email_otp(email: str, otp: str) -> bool:
    em = _norm_email(email)
    code = (otp or "").strip()
    if not re.fullmatch(r"\d{6}", code):
        raise HTTPException(400, "Enter a valid 6-digit verification code")
    now = time.time()
    otp_h = _hash_otp(em, code)
    with _sqlite_conn() as conn:
        row = conn.execute(
            "SELECT * FROM email_otps WHERE email = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1",
            (em,),
        ).fetchone()
        if not row:
            raise HTTPException(400, "No active verification code found. Please request a new code.")
        if float(row["expires_at"]) < now:
            conn.execute("UPDATE email_otps SET consumed = 1 WHERE id = ?", (row["id"],))
            conn.commit()
            raise HTTPException(400, "Verification code expired. Please request a new code.")
        if int(row["attempts"]) >= 5:
            conn.execute("UPDATE email_otps SET consumed = 1 WHERE id = ?", (row["id"],))
            conn.commit()
            raise HTTPException(429, "Too many invalid attempts. Please request a new verification code.")
        if not hmac.compare_digest(row["otp_hash"], otp_h):
            conn.execute("UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?", (row["id"],))
            conn.commit()
            raise HTTPException(400, "Invalid verification code")
        conn.execute("UPDATE email_otps SET consumed = 1 WHERE id = ?", (row["id"],))
        conn.commit()
    if DB_URL:
        try:
            pool = await _get_pg_pool()
            async with pool.acquire() as c:
                await c.execute("UPDATE public.email_otps SET consumed = TRUE WHERE email = $1 AND consumed = FALSE", em)
        except Exception:
            pass
    return True


async def _create_auth_session(user_uid: str) -> tuple[str, float]:
    token = secrets.token_urlsafe(32)
    t_hash = _hash_token(token)
    now = time.time()
    exp = now + AUTH_SESSION_TTL_S
    if DB_URL:
        pool = await _get_pg_pool()
        async with pool.acquire() as c:
            await c.execute(
                "INSERT INTO public.auth_sessions (token_hash, user_uid, expires_at, revoked, created_at) VALUES ($1,$2,$3,FALSE,NOW())",
                t_hash, user_uid, datetime.fromtimestamp(exp, tz=timezone.utc),
            )
    with _sqlite_conn() as conn:
        conn.execute(
            "INSERT INTO auth_sessions (token_hash, user_uid, expires_at, revoked, created_at) VALUES (?, ?, ?, 0, ?)",
            (t_hash, user_uid, exp, now),
        )
        conn.commit()
    return token, exp


async def _validate_session_token(token: str | None) -> tuple[dict, float] | None:
    if not token:
        return None
    t_hash = _hash_token(token)
    now = time.time()

    # Authoritative check against Supabase whenever DB_URL is configured
    if DB_URL:
        try:
            pool = await _get_pg_pool()
            async with pool.acquire() as c:
                r = await c.fetchrow("""
                    SELECT s.token_hash, s.user_uid, s.expires_at, s.revoked,
                           u.email, u.name, u.password_hash, u.auth_provider, u.google_sub,
                           u.avatar_url, u.email_verified, COALESCE(u.is_active, TRUE) AS is_active,
                           u.created_at, u.updated_at
                    FROM public.auth_sessions s
                    INNER JOIN public.users u ON u.user_uid = s.user_uid
                    WHERE s.token_hash = $1
                """, t_hash)
                if not r:
                    _purge_local_user(token_hash=t_hash)
                    return None
                exp_ts = r["expires_at"].timestamp() if isinstance(r["expires_at"], datetime) else float(r["expires_at"])
                if r["revoked"] or exp_ts <= now or not r["email_verified"] or not r["is_active"]:
                    if exp_ts <= now and not r["revoked"]:
                        await c.execute("UPDATE public.auth_sessions SET revoked = TRUE WHERE token_hash = $1", t_hash)
                    _purge_local_user(token_hash=t_hash)
                    if not r["is_active"]:
                        _purge_local_user(user_uid=r["user_uid"])
                    return None
                user = _pg_row_to_user(r)
                return user, exp_ts
        except Exception as e:
            print("[auth-pg-validate]", type(e).__name__, e)
            # Fail closed: never trust local cache if Supabase cannot confirm user is still active
            return None

    # Local-only fallback when no DATABASE_URL is configured
    row = None
    with _sqlite_conn() as conn:
        r = conn.execute("SELECT * FROM auth_sessions WHERE token_hash = ?", (t_hash,)).fetchone()
        if r:
            row = dict(r)
    if not row or row.get("revoked"):
        return None
    exp = float(row["expires_at"])
    if exp <= now:
        _purge_local_user(token_hash=t_hash)
        return None
    user = await _auth_get_user(user_uid=row["user_uid"])
    if not user or not user.get("email_verified") or not user.get("is_active", 1):
        _purge_local_user(token_hash=t_hash)
        return None
    return user, exp


async def _revoke_session_token(token: str | None):
    if not token:
        return
    t_hash = _hash_token(token)
    _purge_local_user(token_hash=t_hash)
    if DB_URL:
        try:
            pool = await _get_pg_pool()
            async with pool.acquire() as c:
                await c.execute("UPDATE public.auth_sessions SET revoked = TRUE WHERE token_hash = $1", t_hash)
        except Exception:
            pass


def _extract_token(request: Request) -> str | None:
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    cookie_tok = request.cookies.get(AUTH_COOKIE_NAME)
    if cookie_tok:
        return cookie_tok.strip()
    q_tok = request.query_params.get("token")
    if q_tok:
        return q_tok.strip()
    return None


async def require_auth(request: Request) -> dict:
    tok = _extract_token(request)
    res = await _validate_session_token(tok)
    if not res:
        raise HTTPException(401, "Authentication required or session expired")
    user, exp = res
    return {"user": user, "expires_at": exp, "token": tok}


def _verify_google_id_token_sync(credential: str) -> dict:
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(500, "Google Sign-In is not configured on the server")
    url = "https://oauth2.googleapis.com/tokeninfo?" + urllib.parse.urlencode({"id_token": credential})
    req = urllib.request.Request(url, headers={"User-Agent": "AegisRoverCommand/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            info = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError:
        raise HTTPException(401, "Invalid or expired Google credential")
    except Exception as e:
        raise HTTPException(502, f"Unable to verify Google token: {type(e).__name__}")

    if info.get("aud") != GOOGLE_CLIENT_ID:
        raise HTTPException(401, "Google token audience mismatch")
    if info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise HTTPException(401, "Invalid Google token issuer")
    if str(info.get("email_verified", "")).lower() != "true":
        raise HTTPException(401, "Google account email is not verified")
    try:
        if int(info.get("exp", 0)) <= int(time.time()):
            raise HTTPException(401, "Google token expired")
    except ValueError:
        raise HTTPException(401, "Malformed Google token expiry")
    if not info.get("email") or not info.get("sub"):
        raise HTTPException(401, "Incomplete Google profile claims")
    return info


def _auth_session_response(user: dict, token: str, exp: float) -> JSONResponse:
    resp = JSONResponse({
        "ok": True,
        "token": token,
        "expires_at": exp,
        "user": _public_user(user),
    })
    resp.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        max_age=AUTH_SESSION_TTL_S,
        httponly=True,
        samesite="lax",
        path="/",
    )
    return resp


def _save_session_sqlite(sess: dict, synced: int = 0):
    try:
        with _sqlite_conn() as conn:
            conn.execute("""
                INSERT INTO vehicle_sessions (
                    session_uid, device_id, started_at, ended_at, duration_s,
                    is_active, on_reason, off_reason, telemetry_summary, telemetry_samples, updated_at, synced
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_uid) DO UPDATE SET
                    ended_at = excluded.ended_at,
                    duration_s = excluded.duration_s,
                    is_active = excluded.is_active,
                    off_reason = excluded.off_reason,
                    telemetry_summary = excluded.telemetry_summary,
                    telemetry_samples = excluded.telemetry_samples,
                    updated_at = excluded.updated_at,
                    synced = excluded.synced
            """, (
                sess["session_uid"],
                sess["device_id"],
                float(sess["started_at"]),
                float(sess["ended_at"]) if sess.get("ended_at") is not None else None,
                float(sess.get("duration_s", 0.0)),
                1 if sess.get("is_active") else 0,
                sess.get("on_reason") or "ESP32 Car Connected",
                sess.get("off_reason"),
                json.dumps(sess.get("summary") or {}),
                json.dumps(sess.get("samples") or []),
                time.time(),
                synced,
            ))
            conn.commit()
    except Exception as e:
        print("[session-sqlite]", type(e).__name__, e)


def _new_stat():
    return {"min": None, "max": None, "sum": 0.0, "count": 0, "last": None}


def _update_stat(st: dict, val):
    if val is None:
        return
    try:
        v = float(val)
    except (TypeError, ValueError):
        return
    st["min"] = v if st["min"] is None else min(st["min"], v)
    st["max"] = v if st["max"] is None else max(st["max"], v)
    st["sum"] += v
    st["count"] += 1
    st["last"] = v


def _stat_avg(st: dict, digits: int = 1):
    if not st or not st.get("count"):
        return None
    return round(st["sum"] / st["count"], digits)


def _start_session(now: float, reason: str = "ESP32 Car Connected"):
    global active_session
    if active_session is not None:
        return active_session
    uid = uuid.uuid4().hex[:12]
    active_session = {
        "session_uid": uid,
        "device_id": UNIT,
        "started_at": now,
        "ended_at": now,
        "duration_s": 0.0,
        "is_active": True,
        "on_reason": reason,
        "off_reason": None,
        "last_sample_t": 0.0,
        "last_persist_t": now,
        "prev_blocked": False,
        "prev_estop": bool(state["estop"]),
        "summary": {
            "sample_count": 0,
            "temp_c": _new_stat(),
            "humidity_pct": _new_stat(),
            "gas_raw": _new_stat(),
            "hazard_score": _new_stat(),
            "speed_a": _new_stat(),
            "speed_b": _new_stat(),
            "servo_angle": _new_stat(),
            "front_dist_cm": _new_stat(),
            "stop_cm": _new_stat(),
            "rssi_dbm": _new_stat(),
            "directions": {},
            "commands": {},
            "servo_modes": {},
            "gas_states": {},
            "blocked_events": 0,
            "estop_events": 1 if state["estop"] else 0,
            "glove_link_hits": 0,
            "alerts": [],
        },
        "samples": [],
    }
    _save_session_sqlite(active_session, synced=0)
    session_sync_queue.append(uid)
    return active_session


def _make_sample(now: float) -> dict:
    tel = telemetry()
    m = devs["main"]["data"]
    return {
        "t": round(now, 1),
        "dir": tel["direction"],
        "cmd": tel["command"],
        "speed_a": tel["speed_a"],
        "speed_b": tel["speed_b"],
        "servo": tel["servo_angle"],
        "servo_mode": str(m.get("servo_mode") or "sweep"),
        "dist_cm": tel["front_dist_cm"],
        "stop_cm": tel["stop_cm"],
        "blocked": bool(m.get("blocked")),
        "temp_c": round(tel["temp_c"], 1) if tel["temp_c"] > 0 else None,
        "hum_pct": round(tel["humidity_pct"], 1) if tel["humidity_pct"] > 0 else None,
        "gas_raw": tel["gas_raw"],
        "gas_state": str(m.get("gas_state") or "Normal"),
        "rssi": tel["rssi_dbm"],
        "hazard": tel["hazard_score"],
        "estop": bool(state["estop"]),
    }


def _record_session_sample(now: float):
    global active_session
    if active_session is None:
        _start_session(now, "ESP32 Car Connected")
    s = active_session
    tel = telemetry()
    m = devs["main"]["data"]
    sm = s["summary"]

    s["ended_at"] = now
    s["duration_s"] = round(max(0.0, now - s["started_at"]), 1)
    sm["sample_count"] += 1

    if m.get("dht_ok", True) and tel["temp_c"] > 0:
        _update_stat(sm["temp_c"], tel["temp_c"])
    if m.get("dht_ok", True) and tel["humidity_pct"] > 0:
        _update_stat(sm["humidity_pct"], tel["humidity_pct"])
    _update_stat(sm["gas_raw"], tel["gas_raw"])
    _update_stat(sm["hazard_score"], tel["hazard_score"])
    _update_stat(sm["speed_a"], tel["speed_a"])
    _update_stat(sm["speed_b"], tel["speed_b"])
    if m.get("servo") is not None:
        _update_stat(sm["servo_angle"], m.get("servo"))
    if tel["front_dist_cm"] < 999:
        _update_stat(sm["front_dist_cm"], tel["front_dist_cm"])
    if m.get("stop_cm") is not None:
        _update_stat(sm["stop_cm"], m.get("stop_cm"))
    if devs["main"]["rssi"] is not None:
        _update_stat(sm["rssi_dbm"], devs["main"]["rssi"])

    d_lbl = tel["direction"]
    c_lbl = tel["command"]
    sm["directions"][d_lbl] = sm["directions"].get(d_lbl, 0) + 1
    sm["commands"][c_lbl] = sm["commands"].get(c_lbl, 0) + 1
    s_mode = str(m.get("servo_mode") or "sweep")
    sm["servo_modes"][s_mode] = sm["servo_modes"].get(s_mode, 0) + 1
    g_state = str(m.get("gas_state") or "Normal")
    sm["gas_states"][g_state] = sm["gas_states"].get(g_state, 0) + 1

    if m.get("glove_link"):
        sm["glove_link_hits"] += 1
    is_blk = bool(m.get("blocked"))
    if is_blk and not s["prev_blocked"]:
        sm["blocked_events"] += 1
    s["prev_blocked"] = is_blk

    is_est = bool(state["estop"])
    if is_est and not s["prev_estop"]:
        sm["estop_events"] += 1
    s["prev_estop"] = is_est

    # Capture timeline sample once per >= 1.0s (bounded to 400 points via downsampling)
    if now - s["last_sample_t"] >= 1.0:
        s["last_sample_t"] = now
        s["samples"].append(_make_sample(now))
        if len(s["samples"]) > 400:
            s["samples"] = s["samples"][::2]

    if now - s["last_persist_t"] >= 5.0:
        s["last_persist_t"] = now
        _save_session_sqlite(s, synced=0)
        if s["session_uid"] not in session_sync_queue:
            session_sync_queue.append(s["session_uid"])


def _end_session(now: float, reason: str = "ESP32 Car Disconnected"):
    global active_session
    if active_session is None:
        return None
    s = active_session
    # Capture closing sample without double-counting summary stats
    if devs["main"]["data"] and (not s["samples"] or s["last_sample_t"] < devs["main"]["last"]):
        s["samples"].append(_make_sample(now))
    active_session = None
    s["ended_at"] = max(now, s["started_at"])
    s["duration_s"] = round(max(0.0, s["ended_at"] - s["started_at"]), 1)
    s["is_active"] = False
    s["off_reason"] = reason
    _save_session_sqlite(s, synced=0)
    if s["session_uid"] not in session_sync_queue:
        session_sync_queue.append(s["session_uid"])
    return s


def _normalize_wifi_aps(raw_aps: list) -> list[dict]:
    """Validate, deduplicate, and sort Wi-Fi AP scan entries strongest-first."""
    by_mac: dict[str, dict] = {}
    for item in raw_aps:
        if not isinstance(item, dict):
            continue
        mac = str(item.get("bssid") or item.get("macAddress") or "").strip().lower()
        if not _MAC_RE.match(mac) or mac in ("00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"):
            continue
        try:
            rssi = int(item.get("rssi") if item.get("rssi") is not None else item.get("signalStrength"))
        except (TypeError, ValueError):
            continue
        if rssi > 0 or rssi < -120:
            continue
        entry = {"macAddress": mac, "signalStrength": rssi}
        ch = item.get("ch") if item.get("ch") is not None else item.get("channel")
        try:
            ch_i = int(ch)
            if 1 <= ch_i <= 165:
                entry["channel"] = ch_i
        except (TypeError, ValueError):
            pass
        prev = by_mac.get(mac)
        if prev is None or rssi > prev["signalStrength"]:
            by_mac[mac] = entry
    ordered = sorted(by_mac.values(), key=lambda x: x["signalStrength"], reverse=True)
    return ordered[:15]


def _sanitize_geo_err(msg: str) -> str:
    return re.sub(r"(key=)[^&\s]+", r"\1***", str(msg or "Geolocation lookup failed"))[:160]


def _google_geolocate_sync(wifi_aps: list[dict]) -> dict:
    if not GOOGLE_GEOLOCATION_API_KEY:
        raise RuntimeError("Google Geolocation API key not configured on backend")
    url = "https://www.googleapis.com/geolocation/v1/geolocate?" + urllib.parse.urlencode(
        {"key": GOOGLE_GEOLOCATION_API_KEY}
    )
    body = json.dumps({"considerIp": False, "wifiAccessPoints": wifi_aps}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = f"HTTP {e.code}"
        try:
            err_body = json.loads(e.read().decode("utf-8"))
            err_msg = (err_body.get("error") or {}).get("message")
            if err_msg:
                detail = f"HTTP {e.code}: {err_msg}"
        except Exception:
            pass
        raise RuntimeError(_sanitize_geo_err(detail))
    except Exception as e:
        raise RuntimeError(_sanitize_geo_err(f"Geolocation request error ({type(e).__name__})"))

    loc = data.get("location") or {}
    lat = loc.get("lat")
    lng = loc.get("lng")
    acc = data.get("accuracy")
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        raise RuntimeError("Invalid coordinates returned by Google Geolocation API")
    if not (-90 <= float(lat) <= 90 and -180 <= float(lng) <= 180):
        raise RuntimeError("Out-of-range coordinates returned by Google Geolocation API")
    acc_val = float(acc) if isinstance(acc, (int, float)) and float(acc) > 0 else 100.0
    return {"lat": float(lat), "lng": float(lng), "accuracy": acc_val}


async def _resolve_wifi_location(raw_aps: list):
    now = time.time()
    location_state["last_scan_at"] = now
    aps = _normalize_wifi_aps(raw_aps)
    if len(aps) < 2:
        location_state["error"] = "Need at least 2 nearby Wi-Fi networks to estimate location"
        return
    if not GOOGLE_GEOLOCATION_API_KEY:
        location_state["error"] = "Google Geolocation API key missing in server .env"
        return
    if location_state["resolving"] or (now - location_state["last_api_t"] < LOCATION_MIN_INTERVAL_S):
        return

    location_state["resolving"] = True
    location_state["last_api_t"] = now
    try:
        res = await asyncio.to_thread(_google_geolocate_sync, aps)
        location_state["lat"] = round(res["lat"], 7)
        location_state["lng"] = round(res["lng"], 7)
        location_state["accuracy_m"] = round(res["accuracy"], 1)
        location_state["ap_count"] = len(aps)
        location_state["updated_at"] = time.time()
        location_state["error"] = None
    except Exception as exc:
        location_state["error"] = _sanitize_geo_err(str(exc))
    finally:
        location_state["resolving"] = False


def _public_location() -> dict:
    now = time.time()
    upd = location_state["updated_at"]
    car_status = status(devs["main"])
    has_fix = location_state["lat"] is not None and location_state["lng"] is not None and upd is not None
    age_s = round(max(0.0, now - upd), 1) if has_fix else None
    stale = bool(has_fix and (age_s > LOCATION_STALE_S or (car_status == "OFFLINE" and age_s > 35.0)))
    acc = location_state["accuracy_m"]
    inaccurate = bool(has_fix and acc is not None and acc > 500.0)
    quality = ("high" if acc <= 120 else ("medium" if acc <= 500 else "low")) if (has_fix and acc is not None) else None
    if has_fix:
        loc_status = "stale" if stale else ("inaccurate" if inaccurate else "ok")
    else:
        loc_status = "error" if location_state["error"] else "unavailable"
    return {
        "status": loc_status,
        "source": "Wi-Fi Estimated",
        "lat": location_state["lat"],
        "lng": location_state["lng"],
        "accuracy_m": acc,
        "accuracy_quality": quality,
        "inaccurate": inaccurate,
        "stale": stale,
        "ap_count": location_state["ap_count"],
        "updated_at": upd,
        "age_s": age_s,
        "last_scan_at": location_state["last_scan_at"],
        "configured": bool(GOOGLE_GEOLOCATION_API_KEY),
        "error": location_state["error"],
    }


def on_message(name, text):
    d, now = devs[name], time.time()
    try: msg = json.loads(text)
    except ValueError: return
    d["last"] = now
    if msg.get("type") == "pong":
        t0 = d["pings"].pop(msg.get("n"), None)
        if t0: d["rtt"] = round((time.perf_counter() - t0) * 1000, 1)
        return
    if msg.get("type") == "wifi_scan" and name == "main":
        aps = msg.get("aps")
        if isinstance(aps, list):
            try:
                asyncio.get_running_loop().create_task(_resolve_wifi_location(aps))
            except RuntimeError:
                pass
        return
    s = msg.get("seq")
    if isinstance(s, int):
        if d["seq"] is not None and s > d["seq"] + 1: d["lost"] += s - d["seq"] - 1
        d["seq"] = s
    d["arr"].append(now)
    d["rssi"] = msg.get("rssi", d["rssi"])
    if isinstance(msg.get("data"), dict): d["data"] = msg["data"]
    if name == "main":
        m = d["data"]
        if m.get("gas_state") == "DANGER": alert("gas", "CRITICAL", "GAS", f"Gas DANGER (raw {m.get('gas_raw')})", hz=hazard())
        elif m.get("gas_state") == "Warning": alert("gas", "ELEVATED", "GAS", f"Gas warning (raw {m.get('gas_raw')})", hz=hazard())
        if m.get("blocked"): alert("blocked", "ELEVATED", "SONAR", f"Obstacle at {m.get('distance_cm')} cm, forward blocked")
        hist.append(dict(t=now, gas=m.get("gas_raw"), temp=m.get("temp_c"), dist=min(m.get("distance_cm", 999), 400),
                         hum=m.get("hum_pct")))
        _record_session_sample(now)
    if d["rssi"] is not None and d["rssi"] < RSSI_MIN: alert("rssi-" + name, "ELEVATED", "LINK", f"{name} signal weak ({d['rssi']} dBm)")


@app.websocket("/ws/{name}")
async def ws_endpoint(ws: WebSocket, name: str):
    await ws.accept()
    if name == "dashboard":
        tok = ws.cookies.get(AUTH_COOKIE_NAME) or ws.query_params.get("token")
        if not await _validate_session_token(tok):
            try:
                await ws.send_text(json.dumps({"error": "Authentication required", "code": 401}))
            except Exception:
                pass
            return await ws.close(code=1008)
        return await dashboard(ws, tok)
    if name not in devs: return await ws.close()
    d = devs[name]
    d.update(ws=ws, ip=ws.client.host if ws.client else None, last=time.time(), seq=None)
    d["conns"] += 1
    if name == "main":
        _start_session(time.time(), "ESP32 Car Connected")

    async def pinger():
        try:
            while True:
                await asyncio.sleep(2)
                d["n"] += 1; d["pings"][d["n"]] = time.perf_counter()
                await ws.send_text(json.dumps({"cmd": "ping", "n": d["n"]}))
        except Exception: pass
    task = asyncio.create_task(pinger())
    try:
        while True: on_message(name, await ws.receive_text())
    except Exception: pass
    finally:
        task.cancel()
        if d["ws"] is ws:
            d["ws"] = None
            if name == "main":
                _end_session(time.time(), "ESP32 Car Disconnected")


async def send(name, payload):
    d = devs.get(name)
    if not d or d["ws"] is None: raise HTTPException(409, f"{name} is not connected")
    await d["ws"].send_text(json.dumps(payload))


async def run_cmd(msg):
    c = msg.get("cmd")
    if c == "servo": await send("main", {"cmd": "servo", **{k: msg[k] for k in ("angle", "mode") if k in msg}})
    elif c == "config": await send("main", {"cmd": "config", **{k: msg[k] for k in ("speedA", "speedB", "stop_cm") if k in msg}})
    elif c == "estop":
        m = devs["main"]["data"]
        if msg.get("on", True) and not state["estop"]:
            state.update(estop=True, prev=(m.get("speedA", 60) or 60, m.get("speedB", 60) or 60))
            await send("main", {"cmd": "config", "speedA": 0, "speedB": 0})
            alert("estop", "CRITICAL", "E-STOP", "Emergency stop engaged (motor speed set to 0)", command="ESTOP")
        elif not msg.get("on", True) and state["estop"]:
            state["estop"] = False
            await send("main", {"cmd": "config", "speedA": state["prev"][0], "speedB": state["prev"][1]})
            cool.pop("estop", None)
    else: raise HTTPException(400, "unknown command")      # the cloud can never drive the motors


def snapshot():
    return dict(t=time.time(), estop=state["estop"],
                db=dict(ok=db["ok"], queue=len(pending), records=db["records"], hist_count=len(hist)),
                tel=telemetry(),
                location=_public_location(),
                nodes=[dict(id=k, title=NODES[k][0], proto=NODES[k][1], ip=d["ip"], status=status(d), rate=rate(d),
                            rtt=d["rtt"], rssi=d["rssi"], lost=d["lost"], conns=d["conns"], data=d["data"])
                       for k, d in devs.items()],
                alerts=[{**a} for a in list(alerts)[:30]], cam=bool(state["jpg"]))


async def dashboard(ws, tok: str | None = None):
    closed = {"flag": False}

    async def _reject_and_close():
        if closed["flag"]:
            return
        closed["flag"] = True
        try:
            await ws.send_text(json.dumps({"error": "Account deleted or session expired", "code": 401}))
        except Exception:
            pass
        try:
            await ws.close(code=1008)
        except Exception:
            pass

    async def sender():
        ticks = 0
        while True:
            ticks += 1
            if ticks % 8 == 0:
                if not await _validate_session_token(tok):
                    await _reject_and_close()
                    return
            await ws.send_text(json.dumps(snapshot()))
            await asyncio.sleep(0.25)

    task = asyncio.create_task(sender())
    try:
        while True:
            raw = await ws.receive_text()
            if not await _validate_session_token(tok):
                await _reject_and_close()
                break
            try:
                await run_cmd(json.loads(raw))
            except HTTPException as e:
                await ws.send_text(json.dumps({"error": e.detail}))
    except Exception:
        pass
    finally:
        task.cancel()


class Cmd(BaseModel):
    payload: dict


class SignupReq(BaseModel):
    name: str
    email: str
    password: str


class VerifyOtpReq(BaseModel):
    email: str
    otp: str


class ResendOtpReq(BaseModel):
    email: str


class LoginReq(BaseModel):
    email: str
    password: str


class GoogleAuthReq(BaseModel):
    credential: str


@app.get("/api/auth/config")
def api_auth_config():
    return {
        "google_client_id": GOOGLE_CLIENT_ID,
        "google_enabled": bool(GOOGLE_CLIENT_ID),
        "email_otp_enabled": bool(RESEND_API_KEY and EMAIL_FROM),
        "otp_ttl_s": OTP_TTL_S,
        "session_ttl_s": AUTH_SESSION_TTL_S,
    }


@app.get("/api/auth/me")
async def api_auth_me(auth: dict = Depends(require_auth)):
    return {
        "authenticated": True,
        "user": _public_user(auth["user"]),
        "expires_at": auth["expires_at"],
    }


@app.post("/api/auth/signup")
async def api_auth_signup(req: SignupReq):
    name = (req.name or "").strip()
    em = _norm_email(req.email)
    pw = req.password or ""
    if len(name) < 2:
        raise HTTPException(400, "Please enter your full name (at least 2 characters)")
    if not _EMAIL_RE.match(em):
        raise HTTPException(400, "Please enter a valid email address")
    if len(pw) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")

    existing = await _auth_get_user(email=em)
    if existing and existing.get("email_verified"):
        raise HTTPException(409, "An account with this email already exists. Please sign in.")

    user_uid = existing["user_uid"] if existing else uuid.uuid4().hex[:16]
    user = {
        "user_uid": user_uid,
        "email": em,
        "name": name[:80],
        "password_hash": _hash_password(pw),
        "auth_provider": "email",
        "google_sub": existing.get("google_sub") if existing else None,
        "avatar_url": existing.get("avatar_url") if existing else None,
        "email_verified": False,
        "created_at": existing.get("created_at", time.time()) if existing else time.time(),
    }
    await _issue_and_send_otp(em, user["name"], enforce_cooldown=False)
    await _auth_save_user(user)
    return {
        "ok": True,
        "requires_otp": True,
        "email": em,
        "message": f"Verification code sent to {em}",
    }


@app.post("/api/auth/verify-otp")
async def api_auth_verify_otp(req: VerifyOtpReq):
    em = _norm_email(req.email)
    user = await _auth_get_user(email=em)
    if not user:
        raise HTTPException(404, "Account not found. Please sign up first.")
    await _verify_email_otp(em, req.otp)
    user["email_verified"] = True
    await _auth_save_user(user)
    token, exp = await _create_auth_session(user["user_uid"])
    return _auth_session_response(user, token, exp)


@app.post("/api/auth/resend-otp")
async def api_auth_resend_otp(req: ResendOtpReq):
    em = _norm_email(req.email)
    if not _EMAIL_RE.match(em):
        raise HTTPException(400, "Invalid email address")
    user = await _auth_get_user(email=em)
    if not user:
        raise HTTPException(404, "Account not found")
    if user.get("email_verified"):
        raise HTTPException(400, "Email is already verified. Please sign in.")
    await _issue_and_send_otp(em, user["name"], enforce_cooldown=True)
    return {"ok": True, "message": f"New verification code sent to {em}"}


@app.post("/api/auth/login")
async def api_auth_login(req: LoginReq):
    em = _norm_email(req.email)
    pw = req.password or ""
    if not _EMAIL_RE.match(em) or not pw:
        raise HTTPException(400, "Email and password are required")
    user = await _auth_get_user(email=em)
    if not user:
        raise HTTPException(401, "Invalid email or password")
    if not user.get("password_hash"):
        raise HTTPException(400, "This account uses Google Sign-In. Click Continue with Google.")
    if not _verify_password(pw, user.get("password_hash")):
        raise HTTPException(401, "Invalid email or password")
    if not user.get("email_verified"):
        try:
            await _issue_and_send_otp(em, user["name"], enforce_cooldown=True)
            msg = "Email not verified yet. A verification code has been sent to your email."
        except HTTPException as e:
            msg = e.detail if e.status_code == 429 else "Email not verified yet. Please verify with your OTP code."
        return JSONResponse(
            status_code=403,
            content={"detail": msg, "requires_otp": True, "email": em},
        )
    token, exp = await _create_auth_session(user["user_uid"])
    return _auth_session_response(user, token, exp)


@app.post("/api/auth/google")
async def api_auth_google(req: GoogleAuthReq):
    cred = (req.credential or "").strip()
    if not cred:
        raise HTTPException(400, "Missing Google credential token")
    info = await asyncio.to_thread(_verify_google_id_token_sync, cred)
    em = _norm_email(info["email"])
    sub = str(info["sub"])
    name = (info.get("name") or em.split("@")[0])[:80]
    avatar = info.get("picture")

    user = await _auth_get_user(google_sub=sub) or await _auth_get_user(email=em)
    if user:
        user["name"] = user.get("name") or name
        user["google_sub"] = sub
        user["avatar_url"] = avatar or user.get("avatar_url")
        user["email_verified"] = True
        if not user.get("password_hash"):
            user["auth_provider"] = "google"
    else:
        user = {
            "user_uid": uuid.uuid4().hex[:16],
            "email": em,
            "name": name,
            "password_hash": None,
            "auth_provider": "google",
            "google_sub": sub,
            "avatar_url": avatar,
            "email_verified": True,
            "created_at": time.time(),
        }
    await _auth_save_user(user)
    token, exp = await _create_auth_session(user["user_uid"])
    return _auth_session_response(user, token, exp)


@app.post("/api/auth/logout")
async def api_auth_logout(request: Request):
    tok = _extract_token(request)
    await _revoke_session_token(tok)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(AUTH_COOKIE_NAME, path="/")
    return resp


@app.post("/api/command")
async def api_command(c: Cmd, _auth: dict = Depends(require_auth)):
    await run_cmd(c.payload); return {"sent": True}


@app.get("/api/health")
def api_health():
    return {
        "status": "ok",
        "unit_id": UNIT,
        "db_ok": db["ok"],
        "uptime_s": round(time.time() - START_TIME, 1),
        "nodes_online": sum(1 for d in devs.values() if status(d) == "ONLINE"),
    }


@app.get("/api/status")
def api_status(_auth: dict = Depends(require_auth)): return snapshot()


@app.get("/api/history")
def api_history(_auth: dict = Depends(require_auth)): return list(hist)


# ---------------- session queries & PDF report builder ----------------
def _parse_date_bounds(date_str: str | None) -> tuple[str, float, float]:
    tz = _local_tz()
    if date_str:
        try:
            d = datetime.strptime(date_str.strip(), "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(400, "Invalid date format, expected YYYY-MM-DD")
    else:
        d = datetime.now(tz).date()
    start_dt = datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=tz)
    end_dt = start_dt + timedelta(days=1)
    return d.isoformat(), start_dt.timestamp(), end_dt.timestamp()


def _serialize_session(raw: dict, include_samples: bool = False) -> dict:
    started = float(raw["started_at"])
    is_act = bool(raw.get("is_active"))
    ended = time.time() if is_act else float(raw.get("ended_at") or started)
    dur = max(0.0, ended - started)
    sm = raw.get("summary") or {}
    out = {
        "session_uid": raw["session_uid"],
        "device_id": raw.get("device_id") or UNIT,
        "started_at": started,
        "ended_at": None if is_act else ended,
        "started_local": _fmt_dt_local(started),
        "ended_local": "ACTIVE NOW" if is_act else _fmt_dt_local(ended),
        "started_time": _fmt_time_local(started),
        "ended_time": "LIVE" if is_act else _fmt_time_local(ended),
        "duration_s": round(dur, 1),
        "duration_text": _fmt_duration(dur),
        "is_active": is_act,
        "on_reason": raw.get("on_reason") or "ESP32 Car Connected",
        "off_reason": raw.get("off_reason") or ("Online" if is_act else "Disconnected"),
        "summary": sm,
    }
    if include_samples:
        out["samples"] = raw.get("samples") or []
    return out


def _row_to_raw_session(r) -> dict:
    sm = r["telemetry_summary"]
    sp = r["telemetry_samples"]
    if isinstance(sm, str):
        sm = json.loads(sm or "{}")
    if isinstance(sp, str):
        sp = json.loads(sp or "[]")
    started = r["started_at"]
    ended = r["ended_at"]
    if isinstance(started, datetime):
        started = started.timestamp()
    if isinstance(ended, datetime):
        ended = ended.timestamp()
    return {
        "session_uid": r["session_uid"],
        "device_id": r["device_id"],
        "started_at": float(started),
        "ended_at": float(ended) if ended is not None else None,
        "duration_s": float(r["duration_s"] or 0),
        "is_active": bool(r["is_active"]),
        "on_reason": r["on_reason"],
        "off_reason": r["off_reason"],
        "summary": sm or {},
        "samples": sp or [],
    }


async def _fetch_sessions_merged(start_ts: float | None = None, end_ts: float | None = None) -> list[dict]:
    merged: dict[str, dict] = {}
    # 1. Local SQLite (offline-safe & fast)
    try:
        with _sqlite_conn() as conn:
            if start_ts is not None and end_ts is not None:
                rows = conn.execute(
                    "SELECT * FROM vehicle_sessions WHERE started_at < ? AND COALESCE(ended_at, started_at) >= ? ORDER BY started_at DESC",
                    (end_ts, start_ts),
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM vehicle_sessions ORDER BY started_at DESC LIMIT 200").fetchall()
            for r in rows:
                raw = _row_to_raw_session(r)
                merged[raw["session_uid"]] = raw
    except Exception as e:
        print("[session-read-sqlite]", type(e).__name__, e)

    # 2. Supabase Postgres (if connected)
    if db["pool"] is not None and db["schema_ready"]:
        try:
            async with db["pool"].acquire() as c:
                if start_ts is not None and end_ts is not None:
                    s_dt = datetime.fromtimestamp(start_ts, tz=timezone.utc)
                    e_dt = datetime.fromtimestamp(end_ts, tz=timezone.utc)
                    rows = await c.fetch(
                        """SELECT session_uid, device_id, started_at, ended_at, duration_s, is_active,
                                  on_reason, off_reason, telemetry_summary, telemetry_samples
                           FROM public.vehicle_sessions
                           WHERE started_at < $1 AND COALESCE(ended_at, started_at) >= $2
                           ORDER BY started_at DESC""",
                        e_dt, s_dt,
                    )
                else:
                    rows = await c.fetch(
                        """SELECT session_uid, device_id, started_at, ended_at, duration_s, is_active,
                                  on_reason, off_reason, telemetry_summary, telemetry_samples
                           FROM public.vehicle_sessions ORDER BY started_at DESC LIMIT 200"""
                    )
                for r in rows:
                    raw = _row_to_raw_session(r)
                    uid = raw["session_uid"]
                    # Prefer finalized/newer sample set over stale row
                    if uid not in merged or (not raw["is_active"] and merged[uid]["is_active"]):
                        merged[uid] = raw
        except Exception as e:
            print("[session-read-pg]", type(e).__name__, e)

    # 3. Overlay live in-memory active session so UI & reports are up-to-the-second
    if active_session is not None:
        uid = active_session["session_uid"]
        s_at = active_session["started_at"]
        if start_ts is None or (s_at < end_ts and time.time() >= start_ts):
            merged[uid] = {
                "session_uid": uid,
                "device_id": active_session["device_id"],
                "started_at": s_at,
                "ended_at": time.time(),
                "duration_s": round(max(0.0, time.time() - s_at), 1),
                "is_active": True,
                "on_reason": active_session.get("on_reason"),
                "off_reason": None,
                "summary": active_session["summary"],
                "samples": active_session["samples"],
            }

    items = list(merged.values())
    items.sort(key=lambda x: x["started_at"], reverse=True)
    return items


async def _get_daily_sessions_payload(date_str: str | None, include_samples: bool = False) -> dict:
    norm_date, start_ts, end_ts = _parse_date_bounds(date_str)
    raw_list = await _fetch_sessions_merged(start_ts, end_ts)
    sessions = [_serialize_session(r, include_samples=include_samples) for r in raw_list]

    total_dur = 0.0
    off_count = 0
    first_on = None
    last_off = None
    active_now = False
    for r in raw_list:
        s = float(r["started_at"])
        is_act = bool(r["is_active"])
        e = time.time() if is_act else float(r.get("ended_at") or s)
        # Clip contribution to the selected calendar date
        c_start = max(s, start_ts)
        c_end = min(e, end_ts)
        if c_end > c_start:
            total_dur += (c_end - c_start)
        if first_on is None or s < first_on:
            first_on = s
        if is_act:
            active_now = True
        else:
            off_count += 1
            if last_off is None or e > last_off:
                last_off = e

    return {
        "date": norm_date,
        "device_id": UNIT,
        "on_count": len(sessions),
        "off_count": off_count,
        "total_duration_s": round(total_dur, 1),
        "total_duration_text": _fmt_duration(total_dur),
        "first_on_local": _fmt_time_local(first_on) if first_on else "--",
        "last_off_local": "ACTIVE NOW" if active_now else (_fmt_time_local(last_off) if last_off else "--"),
        "active_now": active_now,
        "sessions": sessions,
    }


async def _get_single_session(session_uid: str) -> dict | None:
    if active_session is not None and active_session["session_uid"] == session_uid:
        return _serialize_session(
            {**active_session, "ended_at": time.time()}, include_samples=True
        )
    try:
        with _sqlite_conn() as conn:
            row = conn.execute("SELECT * FROM vehicle_sessions WHERE session_uid = ?", (session_uid,)).fetchone()
            if row:
                return _serialize_session(_row_to_raw_session(row), include_samples=True)
    except Exception:
        pass
    if db["pool"] is not None and db["schema_ready"]:
        try:
            async with db["pool"].acquire() as c:
                row = await c.fetchrow(
                    """SELECT session_uid, device_id, started_at, ended_at, duration_s, is_active,
                              on_reason, off_reason, telemetry_summary, telemetry_samples
                       FROM public.vehicle_sessions WHERE session_uid = $1""",
                    session_uid,
                )
                if row:
                    return _serialize_session(_row_to_raw_session(row), include_samples=True)
        except Exception:
            pass
    return None


# ---------------- Pure-Python PDF 1.4 Report Builder (zero external deps) ----------------
def _pdf_clean(text: object) -> str:
    s = str(text if text is not None else "--")
    s = (
        s.replace("°", " deg")
         .replace("≤", "<=")
         .replace("≥", ">=")
         .replace("—", "-")
         .replace("–", "-")
         .replace("•", "*")
         .replace("→", "->")
    )
    return "".join(ch if 32 <= ord(ch) <= 126 else "?" for ch in s)


def _pdf_esc(text: object) -> str:
    return _pdf_clean(text).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _fmt_stat_triplet(st: dict | None, unit: str = "", digits: int = 1) -> str:
    if not st or not st.get("count"):
        return "No readings"
    mn, av, mx = st.get("min"), _stat_avg(st, digits), st.get("max")
    if digits == 0:
        f = lambda v: f"{int(round(v))}"
    else:
        f = lambda v: f"{v:.{digits}f}"
    u = f" {unit}" if unit else ""
    return f"Min {f(mn)}{u} | Avg {f(av)}{u} | Max {f(mx)}{u}"


class PDFReportBuilder:
    """Minimal, self-contained A4 PDF 1.4 vector report writer."""
    W = 595.28
    H = 841.89
    ML = 36.0
    MR = 36.0
    MT = 40.0
    MB = 44.0

    def __init__(self, doc_title: str, subtitle: str):
        self.doc_title = _pdf_clean(doc_title)
        self.subtitle = _pdf_clean(subtitle)
        self.pages: list[list[str]] = []
        self.y = self.MT
        self.generated_str = _fmt_dt_local(time.time())
        self.new_page(first=True)

    @property
    def cw(self) -> float:
        return self.W - self.ML - self.MR

    def _py(self, y_top: float) -> float:
        return self.H - y_top

    def new_page(self, first: bool = False):
        self.pages.append([])
        if first:
            self.y = self.MT
        else:
            # Slim continuation header (well-spaced left & right)
            self._rect(0, 0, self.W, 28, fill=(0.059, 0.09, 0.165))
            self._text(self.ML, 18, self.doc_title[:48], size=8.5, bold=True, color=(1, 1, 1))
            self._text(self.W - self.MR - 165, 18, self.subtitle[:32], size=7.8, color=(0.58, 0.64, 0.72))
            self.y = 44.0

    def ensure_space(self, needed: float):
        if self.y + needed > self.H - self.MB:
            self.new_page(first=False)

    def _cmd(self, s: str):
        self.pages[-1].append(s)

    def _rect(self, x: float, y_top: float, w: float, h: float, fill=None, stroke=None, lw: float = 0.6):
        yb = self._py(y_top + h)
        parts = ["q"]
        if fill is not None:
            parts.append(f"{fill[0]:.3f} {fill[1]:.3f} {fill[2]:.3f} rg")
        if stroke is not None:
            parts.append(f"{lw:.2f} w {stroke[0]:.3f} {stroke[1]:.3f} {stroke[2]:.3f} RG")
        parts.append(f"{x:.2f} {yb:.2f} {w:.2f} {h:.2f} re")
        if fill is not None and stroke is not None:
            parts.append("B")
        elif fill is not None:
            parts.append("f")
        else:
            parts.append("S")
        parts.append("Q")
        self._cmd(" ".join(parts))

    def _line(self, x1: float, y1_top: float, x2: float, y2_top: float, color=(0.8, 0.84, 0.89), lw: float = 0.6):
        self._cmd(
            f"q {lw:.2f} w {color[0]:.3f} {color[1]:.3f} {color[2]:.3f} RG "
            f"{x1:.2f} {self._py(y1_top):.2f} m {x2:.2f} {self._py(y2_top):.2f} l S Q"
        )

    def _text(self, x: float, y_top: float, txt: object, size: float = 9.5, bold: bool = False,
              mono: bool = False, color=(0.12, 0.16, 0.23)):
        font = "/F3" if mono else ("/F2" if bold else "/F1")
        yb = self._py(y_top)
        self._cmd(
            f"BT {font} {size:.1f} Tf {color[0]:.3f} {color[1]:.3f} {color[2]:.3f} rg "
            f"1 0 0 1 {x:.2f} {yb:.2f} Tm ({_pdf_esc(txt)}) Tj ET"
        )

    def draw_banner(self, title: str, subtitle: str, right_meta: list[str]):
        self._rect(0, 0, self.W, 78, fill=(0.059, 0.09, 0.165))
        self._rect(0, 75, self.W, 3, fill=(0.024, 0.714, 0.831))
        # Right metadata box occupies x=[394..559], leaving x=[36..384] strictly for title/subtitle
        self._rect(self.W - self.MR - 168, 12, 168, 52, fill=(0.094, 0.141, 0.235), stroke=(0.18, 0.27, 0.39), lw=0.6)
        self._text(self.ML, 30, _pdf_clean(title)[:40], size=12.5, bold=True, color=(1, 1, 1))
        self._text(self.ML, 49, _pdf_clean(subtitle)[:58], size=8.6, color=(0.58, 0.76, 0.86))
        ry = 25
        for line in right_meta[:3]:
            self._text(self.W - self.MR - 160, ry, _pdf_clean(line)[:29], size=7.6, mono=True, color=(0.82, 0.88, 0.94))
            ry += 14
        self.y = 94.0

    def draw_kpi_row(self, cards: list[tuple[str, str, str]]):
        self.ensure_space(56)
        n = len(cards)
        gap = 8.0
        cw = (self.cw - gap * (n - 1)) / n
        for i, (lbl, val, sub) in enumerate(cards):
            x = self.ML + i * (cw + gap)
            self._rect(x, self.y, cw, 46, fill=(0.969, 0.980, 0.988), stroke=(0.82, 0.86, 0.90), lw=0.7)
            self._rect(x, self.y, 3, 46, fill=(0.024, 0.714, 0.831))
            self._text(x + 8, self.y + 13, _pdf_clean(lbl)[:20], size=6.8, bold=True, color=(0.39, 0.45, 0.55))
            self._text(x + 8, self.y + 28, _pdf_clean(val)[:19], size=9.2, bold=True, color=(0.06, 0.09, 0.17))
            self._text(x + 8, self.y + 40, _pdf_clean(sub)[:24], size=6.8, color=(0.45, 0.50, 0.58))
        self.y += 58.0

    def draw_section(self, title: str):
        self.ensure_space(28)
        self._rect(self.ML, self.y + 2, 3.5, 13, fill=(0.024, 0.714, 0.831))
        self._text(self.ML + 9, self.y + 12, _pdf_clean(title)[:74], size=10.5, bold=True, color=(0.06, 0.09, 0.17))
        self.y += 18.0
        self._line(self.ML, self.y, self.W - self.MR, self.y, color=(0.84, 0.87, 0.91), lw=0.7)
        self.y += 8.0

    def draw_kv_grid(self, items: list[tuple[str, str]], cols: int = 2):
        col_w = self.cw / cols
        row_h = 16.0
        label_offset = 94.0
        for idx in range(0, len(items), cols):
            self.ensure_space(row_h + 4)
            if (idx // cols) % 2 == 0:
                self._rect(self.ML, self.y, self.cw, row_h, fill=(0.975, 0.982, 0.990))
            for c in range(cols):
                if idx + c >= len(items):
                    break
                k, v = items[idx + c]
                x = self.ML + c * col_w + 5
                self._text(x, self.y + 11, f"{_pdf_clean(k)[:18]}:", size=7.8, bold=True, color=(0.35, 0.42, 0.52))
                max_chars = int((col_w - label_offset - 8) / 4.4)
                val_s = _pdf_clean(v)[:max(12, max_chars)]
                self._text(x + label_offset, self.y + 11, val_s, size=7.8, color=(0.09, 0.13, 0.20))
            self.y += row_h
        self.y += 8.0

    def draw_table(self, headers: list[str], rows: list[list[str]], col_widths: list[float], mono_rows: bool = False):
        hdr_h = 18.0
        row_h = 15.0

        def _draw_hdr():
            self._rect(self.ML, self.y, sum(col_widths), hdr_h, fill=(0.118, 0.161, 0.231))
            cx = self.ML + 4
            for h_txt, w in zip(headers, col_widths):
                max_c = max(3, int((w - 6) / 4.6))
                self._text(cx, self.y + 12.5, _pdf_clean(h_txt)[:max_c], size=7.6, bold=True, color=(1, 1, 1))
                cx += w
            self.y += hdr_h

        self.ensure_space(hdr_h + row_h + 6)
        _draw_hdr()
        if not rows:
            self._rect(self.ML, self.y, sum(col_widths), row_h, fill=(0.98, 0.985, 0.99), stroke=(0.88, 0.90, 0.93))
            self._text(self.ML + 8, self.y + 11, "No records available.", size=8.0, color=(0.45, 0.5, 0.58))
            self.y += row_h + 8
            return

        for r_i, row in enumerate(rows):
            if self.y + row_h > self.H - self.MB:
                self.new_page(first=False)
                _draw_hdr()
            bg = (0.97, 0.98, 0.99) if r_i % 2 == 1 else (1.0, 1.0, 1.0)
            self._rect(self.ML, self.y, sum(col_widths), row_h, fill=bg, stroke=(0.90, 0.92, 0.95), lw=0.4)
            cx = self.ML + 4
            for cell, w in zip(row, col_widths):
                max_c = max(3, int((w - 6) / (4.4 if mono_rows else 4.2)))
                self._text(cx, self.y + 10.8, _pdf_clean(cell)[:max_c], size=7.3, mono=mono_rows, color=(0.12, 0.16, 0.23))
                cx += w
            self.y += row_h
        self.y += 10.0

    def build(self) -> bytes:
        total = len(self.pages)
        for idx, page_cmds in enumerate(self.pages, start=1):
            y_ft = self.H - 22.0
            self._cmd(
                f"q 0.5 w 0.85 0.88 0.92 RG {self.ML:.2f} {self._py(y_ft - 10):.2f} m "
                f"{self.W - self.MR:.2f} {self._py(y_ft - 10):.2f} l S Q"
            )
            ft_l = f"Aegis Rover Command (GloveDrive)  |  Generated: {self.generated_str}"
            ft_r = f"Page {idx} of {total}"
            page_cmds.append(
                f"BT /F1 7.5 Tf 0.45 0.50 0.58 rg 1 0 0 1 {self.ML:.2f} {self._py(y_ft):.2f} Tm ({_pdf_esc(ft_l)}) Tj ET"
            )
            page_cmds.append(
                f"BT /F1 7.5 Tf 0.45 0.50 0.58 rg 1 0 0 1 {self.W - self.MR - 52:.2f} {self._py(y_ft):.2f} Tm ({_pdf_esc(ft_r)}) Tj ET"
            )

        objs: list[bytes] = []
        # 1: Catalog, 2: Pages, 3-5: Standard Type1 Fonts
        page_obj_nums = [6 + i * 2 for i in range(total)]
        kids = " ".join(f"{n} 0 R" for n in page_obj_nums)
        objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
        objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {total} >>".encode("ascii"))
        objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
        objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
        objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>")

        for i, cmds in enumerate(self.pages):
            p_num = 6 + i * 2
            c_num = p_num + 1
            stream = "\n".join(cmds).encode("latin-1", "replace")
            objs.append(
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {self.W:.2f} {self.H:.2f}] "
                f"/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents {c_num} 0 R >>".encode("ascii")
            )
            objs.append(
                f"<< /Length {len(stream)} >>\nstream\n".encode("ascii") + stream + b"\nendstream"
            )

        buf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for idx, obj in enumerate(objs, start=1):
            offsets.append(len(buf))
            buf.extend(f"{idx} 0 obj\n".encode("ascii"))
            buf.extend(obj)
            buf.extend(b"\nendobj\n")

        xref_pos = len(buf)
        buf.extend(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode("ascii"))
        for off in offsets[1:]:
            buf.extend(f"{off:010d} 00000 n \n".encode("ascii"))
        buf.extend(
            f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii")
        )
        return bytes(buf)


def _session_kv_pairs(sess: dict) -> list[tuple[str, str]]:
    sm = sess.get("summary") or {}
    dirs = ", ".join(f"{k}({v})" for k, v in (sm.get("directions") or {}).items()) or "None"
    cmds = ", ".join(f"{k}({v})" for k, v in (sm.get("commands") or {}).items()) or "None"
    s_modes = ", ".join(f"{k}({v})" for k, v in (sm.get("servo_modes") or {}).items()) or "None"
    g_states = ", ".join(f"{k}({v})" for k, v in (sm.get("gas_states") or {}).items()) or "Normal"
    return [
        ("Session ID", sess.get("session_uid", "--")),
        ("Vehicle Unit", sess.get("device_id", UNIT)),
        ("Car ON (Start)", sess.get("started_local", "--")),
        ("Car OFF (End)", sess.get("ended_local", "--")),
        ("Total Duration", sess.get("duration_text", "--")),
        ("ON / OFF Events", f"{sess.get('on_reason', '--')} / {sess.get('off_reason', '--')}"),
        ("Motor A Speed", _fmt_stat_triplet(sm.get("speed_a"), "%", 0)),
        ("Motor B Speed", _fmt_stat_triplet(sm.get("speed_b"), "%", 0)),
        ("Servo Angle", _fmt_stat_triplet(sm.get("servo_angle"), "deg", 0)),
        ("Servo Modes", s_modes),
        ("Ultrasonic Dist", _fmt_stat_triplet(sm.get("front_dist_cm"), "cm", 0)),
        ("Stop Threshold", _fmt_stat_triplet(sm.get("stop_cm"), "cm", 0)),
        ("Temperature", _fmt_stat_triplet(sm.get("temp_c"), "C", 1)),
        ("Humidity", _fmt_stat_triplet(sm.get("humidity_pct"), "%", 1)),
        ("MQ Gas ADC", _fmt_stat_triplet(sm.get("gas_raw"), "ADC", 0)),
        ("Gas States", g_states),
        ("Wi-Fi RSSI", _fmt_stat_triplet(sm.get("rssi_dbm"), "dBm", 0)),
        ("Hazard Score", _fmt_stat_triplet(sm.get("hazard_score"), "/100", 0)),
        ("Obstacle Blocks", f"{sm.get('blocked_events', 0)} events | E-Stop: {sm.get('estop_events', 0)}"),
        ("Telemetry Samples", f"{sm.get('sample_count', 0)} packets logged"),
        ("Directions Used", dirs),
        ("Glove Commands", cmds),
    ]


def _sample_rows_for_pdf(samples: list[dict], max_rows: int = 80) -> list[list[str]]:
    if not samples:
        return []
    if len(samples) > max_rows:
        step = len(samples) / max_rows
        chosen = [samples[int(i * step)] for i in range(max_rows - 1)] + [samples[-1]]
    else:
        chosen = samples
    rows = []
    for sp in chosen:
        dist_v = sp.get("dist_cm")
        dist_s = f"{dist_v}cm" if dist_v is not None and dist_v < 999 else "--"
        t_s = f"{sp['temp_c']:.1f}C" if sp.get("temp_c") is not None else "--"
        h_s = f"{sp['hum_pct']:.0f}%" if sp.get("hum_pct") is not None else "--"
        rows.append([
            _fmt_time_local(sp.get("t")),
            sp.get("dir", "--")[:7],
            f"{sp.get('speed_a', 0)}/{sp.get('speed_b', 0)}%",
            f"{sp.get('servo', '--')}d",
            f"{dist_s}/{sp.get('stop_cm', '--')}",
            t_s,
            h_s,
            str(sp.get("gas_raw", "--")),
            str(sp.get("rssi", "--")),
            str(sp.get("hazard", "--")),
        ])
    return rows


def _build_daily_pdf(daily: dict) -> bytes:
    date_str = daily["date"]
    pdf = PDFReportBuilder(
        "AEGIS ROVER COMMAND - DAILY VEHICLE REPORT",
        f"Date: {date_str} | Unit: {daily['device_id']}",
    )
    pdf.draw_banner(
        "AEGIS ROVER - DAILY VEHICLE SESSION REPORT",
        f"Car ON/OFF Activity, Duration & Full Telemetry Summary  ({date_str})",
        [f"Unit: {daily['device_id']}", f"Date: {date_str}", f"Generated: {_fmt_time_local(time.time())}"],
    )
    pdf.draw_kpi_row([
        ("CAR ON / OFF CYCLES", f"{daily['on_count']} ON / {daily['off_count']} OFF", "Recorded power cycles"),
        ("TOTAL ACTIVE TIME", daily["total_duration_text"], f"{daily['total_duration_s']} s total"),
        ("FIRST ON -> LAST OFF", f"{daily['first_on_local']} - {daily['last_off_local']}", "Daily active window"),
        ("CURRENT STATUS", "ONLINE (LIVE)" if daily["active_now"] else "OFFLINE", f"{len(daily['sessions'])} session(s)"),
    ])

    sessions_chrono = list(reversed(daily["sessions"]))
    pdf.draw_section(f"Session Timeline Overview ({len(sessions_chrono)} Sessions)")
    overview_rows = []
    for idx, s in enumerate(sessions_chrono, start=1):
        sm = s.get("summary") or {}
        sp_a = _stat_avg(sm.get("speed_a"), 0)
        sp_b = _stat_avg(sm.get("speed_b"), 0)
        srv = sm.get("servo_angle") or {}
        dst = sm.get("front_dist_cm") or {}
        gas = sm.get("gas_raw") or {}
        overview_rows.append([
            str(idx),
            "LIVE" if s["is_active"] else "DONE",
            s["started_time"],
            s["ended_time"],
            s["duration_text"],
            f"{int(sp_a) if sp_a is not None else 0}/{int(sp_b) if sp_b is not None else 0}%",
            f"{int(srv['min'])}-{int(srv['max'])}d" if srv.get("count") else "--",
            f"{int(dst['min'])}cm" if dst.get("count") else "--",
            f"{int(gas['max'])}" if gas.get("count") else "--",
        ])
    pdf.draw_table(
        ["#", "Stat", "Car ON", "Car OFF", "Duration", "Avg Spd", "Servo", "MinDist", "MaxGas"],
        overview_rows,
        [24, 38, 60, 60, 66, 62, 66, 66, 81],
        mono_rows=True,
    )

    for idx, s in enumerate(sessions_chrono, start=1):
        pdf.draw_section(f"Session #{idx} ({s['session_uid']}) - {s['started_local']} to {s['ended_local']}")
        pdf.draw_kv_grid(_session_kv_pairs(s), cols=2)
        s_alerts = (s.get("summary") or {}).get("alerts") or []
        if s_alerts:
            pdf.draw_table(
                ["Time", "Severity", "Source", "Alert Message"],
                [[_fmt_time_local(a.get("t")), a.get("severity", ""), a.get("source", ""), a.get("message", "")] for a in s_alerts[:15]],
                [65, 65, 65, 328],
            )
        sample_rows = _sample_rows_for_pdf(s.get("samples") or [], max_rows=30)
        if sample_rows:
            pdf.draw_table(
                ["Time", "Dir", "Spd A/B", "Srv", "Dist/Stop", "Temp", "Hum", "Gas", "RSSI", "Haz"],
                sample_rows,
                [56, 54, 58, 42, 70, 48, 42, 52, 50, 51],
                mono_rows=True,
            )

    return pdf.build()


def _build_session_pdf(sess: dict) -> bytes:
    sm = sess.get("summary") or {}
    pdf = PDFReportBuilder(
        f"VEHICLE SESSION REPORT - {sess['session_uid']}",
        f"Unit: {sess['device_id']} | {sess['started_local']}",
    )
    pdf.draw_banner(
        "AEGIS ROVER - SESSION TELEMETRY REPORT",
        f"Session ID: {sess['session_uid']}  |  Car ON: {sess['started_local']}",
        [f"Unit: {sess['device_id']}", f"Duration: {sess['duration_text']}", f"Status: {'ACTIVE' if sess['is_active'] else 'COMPLETED'}"],
    )
    sp_a = _stat_avg(sm.get("speed_a"), 0)
    sp_b = _stat_avg(sm.get("speed_b"), 0)
    hz_mx = (sm.get("hazard_score") or {}).get("max")
    pdf.draw_kpi_row([
        ("CAR ON TIMESTAMP", sess["started_time"], sess["started_local"][:10]),
        ("CAR OFF TIMESTAMP", sess["ended_time"], sess.get("off_reason") or "Active"),
        ("SESSION DURATION", sess["duration_text"], f"{sess['duration_s']} s"),
        ("AVG SPEED / PEAK HAZ", f"{int(sp_a or 0)}% / {int(sp_b or 0)}%", f"Peak Hazard: {int(hz_mx) if hz_mx is not None else 0}/100"),
    ])

    pdf.draw_section("Session Summary, Actuators & Sensor Metrics")
    pdf.draw_kv_grid(_session_kv_pairs(sess), cols=2)

    s_alerts = sm.get("alerts") or []
    if s_alerts:
        pdf.draw_section(f"Safety Alerts Recorded ({len(s_alerts)})")
        pdf.draw_table(
            ["Time", "Severity", "Source", "Alert Message"],
            [[_fmt_time_local(a.get("t")), a.get("severity", ""), a.get("source", ""), a.get("message", "")] for a in s_alerts],
            [65, 65, 65, 328],
        )

    samples = sess.get("samples") or []
    pdf.draw_section(f"Telemetry Timeline ({len(samples)} Samples Captured)")
    pdf.draw_table(
        ["Time", "Dir", "Spd A/B", "Srv", "Dist/Stop", "Temp", "Hum", "Gas", "RSSI", "Haz"],
        _sample_rows_for_pdf(samples, max_rows=140),
        [56, 54, 58, 42, 70, 48, 42, 52, 50, 51],
        mono_rows=True,
    )
    return pdf.build()


@app.get("/api/sessions")
async def api_sessions(date: str | None = Query(default=None), _auth: dict = Depends(require_auth)):
    return await _get_daily_sessions_payload(date, include_samples=False)


@app.get("/api/sessions/report.pdf")
async def api_sessions_daily_pdf(date: str | None = Query(default=None), _auth: dict = Depends(require_auth)):
    daily = await _get_daily_sessions_payload(date, include_samples=True)
    pdf_bytes = _build_daily_pdf(daily)
    fname = f"aegis_daily_report_{daily['date']}.pdf"
    return Response(
        pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"', "Cache-Control": "no-store"},
    )


@app.get("/api/sessions/{session_uid}")
async def api_session_detail(session_uid: str, _auth: dict = Depends(require_auth)):
    sess = await _get_single_session(session_uid)
    if not sess:
        raise HTTPException(404, "session not found")
    return sess


@app.get("/api/sessions/{session_uid}/report.pdf")
async def api_session_pdf(session_uid: str, _auth: dict = Depends(require_auth)):
    sess = await _get_single_session(session_uid)
    if not sess:
        raise HTTPException(404, "session not found")
    pdf_bytes = _build_session_pdf(sess)
    date_part = (sess.get("started_local") or "report")[:10]
    fname = f"aegis_session_{session_uid}_{date_part}.pdf"
    return Response(
        pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"', "Cache-Control": "no-store"},
    )


@app.post("/api/alerts/{alert_id}/ack")
def api_ack_alert(alert_id: int, _auth: dict = Depends(require_auth)):
    for a in alerts:
        if a.get("id") == alert_id:
            a["acked"] = True
            return {"acked": True, "id": alert_id}
    raise HTTPException(404, "alert not found")


@app.get("/api/cam-status")
@app.get("/api/camera/status")
def api_cam_status(_auth: dict = Depends(require_auth)):
    """Camera health check: whether a frame is available and how old it is."""
    cam_node = devs["cam"]
    return {
        "frame_available": bool(state["jpg"]),
        "frame_age_s": round(time.time() - state.get("jpg_t", 0), 1) if state["jpg"] else None,
        "cam_node_status": status(cam_node),
        "cam_ip": cam_node.get("ip"),
        "cam_data": cam_node.get("data", {}),
        "upstream_configured": bool(CAMERA_STREAM_URL),
    }


@app.get("/api/camera/stream")
async def api_camera_stream(_auth: dict = Depends(require_auth)):
    """MJPEG stream relay served from backend-buffered frames (never exposes camera IP)."""
    if not state["jpg"] and status(devs["cam"]) != "ONLINE" and not CAMERA_STREAM_URL:
        raise HTTPException(503, "camera stream unavailable")

    async def frame_generator():
        last_t = 0.0
        idle_ticks = 0
        while True:
            jpg = state["jpg"]
            jpg_t = state.get("jpg_t", 0)
            if jpg and jpg_t != last_t:
                last_t = jpg_t
                idle_ticks = 0
                header = (
                    f"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {len(jpg)}\r\n\r\n"
                ).encode("ascii")
                yield header + jpg + b"\r\n"
            else:
                idle_ticks += 1
                if idle_ticks > 40:  # ~8s with no frames -> close cleanly
                    break
            await asyncio.sleep(0.2)

    return StreamingResponse(
        frame_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/latest.jpg")
def latest(_auth: dict = Depends(require_auth)):
    if not state["jpg"]: raise HTTPException(404, "no frame yet")
    return Response(state["jpg"], media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/")
def index():
    return FileResponse(
        Path(__file__).parent / "static" / "index.html",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


# ---------------- background tasks ----------------
async def logger():
    while True:
        await asyncio.sleep(LOG_S)
        if status(devs["main"]) == "ONLINE": pending.append(("telemetry_logs", telemetry()))


async def watchdog():
    last = {}
    while True:
        await asyncio.sleep(1)
        for k, d in devs.items():
            s = status(d)
            if s != "ONLINE" and last.get(k) == "ONLINE":
                alert("down-" + k, "ELEVATED", "LINK", f"{NODES[k][0]} is {s}")
                if k == "main":
                    _end_session(time.time(), f"Signal Timeout ({s})")
            elif k == "main" and s == "ONLINE" and active_session is None:
                _start_session(time.time(), "ESP32 Car Online")
            last[k] = s


def _fetch_jpeg_from_url(url: str) -> bytes | None:
    """Fetch one JPEG frame from either a single-frame (/capture) or MJPEG (/stream) endpoint."""
    with urllib.request.urlopen(url, timeout=3) as r:
        ctype = (r.headers.get("Content-Type") or "").lower()
        if "multipart/x-mixed-replace" not in ctype:
            return r.read()
        buf = bytearray()
        for _ in range(64):
            chunk = r.read(4096)
            if not chunk:
                break
            buf.extend(chunk)
            start = buf.find(b"\xff\xd8")
            if start != -1:
                end = buf.find(b"\xff\xd9", start + 2)
                if end != -1:
                    return bytes(buf[start : end + 2])
            if len(buf) > 512 * 1024:
                break
    return None


async def cam_loop():
    n = 0
    while True:
        await asyncio.sleep(CAM_S)
        ip = devs["cam"]["ip"]
        if ip and devs["cam"]["ws"] is not None:
            src_url = f"http://{ip}/capture"
        elif CAMERA_STREAM_URL:
            src_url = CAMERA_STREAM_URL
        else:
            continue
        try:
            jpg = await asyncio.to_thread(_fetch_jpeg_from_url, src_url)
            if jpg:
                state["jpg"] = jpg
                state["jpg_t"] = time.time()
            else:
                continue
        except Exception:
            continue
        n += 1
        if n % 10 == 0 and devs["cam"]["ws"] is not None:
            pending.append(("vision_snapshots", dict(device_id=UNIT, fps=int(devs["cam"]["data"].get("fps", 0)),
                                                     person_detected=False, confidence=0.0, hazard_score=hazard())))


async def _ensure_db_schema(c):
    if db["schema_ready"]:
        return
    await c.execute("""
        ALTER TABLE public.telemetry_logs
            ADD COLUMN IF NOT EXISTS servo_angle INT DEFAULT 90,
            ADD COLUMN IF NOT EXISTS stop_cm INT DEFAULT 20;
    """)
    await c.execute("""
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
    """)
    await c.execute("CREATE INDEX IF NOT EXISTS idx_sessions_device_started ON public.vehicle_sessions (device_id, started_at DESC);")
    await c.execute("""
        CREATE TABLE IF NOT EXISTS public.users (
            id              BIGSERIAL PRIMARY KEY,
            user_uid        TEXT        UNIQUE NOT NULL,
            email           TEXT        UNIQUE NOT NULL,
            name            TEXT        NOT NULL,
            password_hash   TEXT,
            auth_provider   TEXT        NOT NULL DEFAULT 'email',
            google_sub      TEXT        UNIQUE,
            avatar_url      TEXT,
            email_verified  BOOLEAN     NOT NULL DEFAULT FALSE,
            is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)
    await c.execute("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;")
    await c.execute("""
        CREATE TABLE IF NOT EXISTS public.email_otps (
            id              BIGSERIAL PRIMARY KEY,
            email           TEXT        NOT NULL,
            otp_hash        TEXT        NOT NULL,
            expires_at      TIMESTAMPTZ NOT NULL,
            attempts        INT         NOT NULL DEFAULT 0,
            consumed        BOOLEAN     NOT NULL DEFAULT FALSE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)
    await c.execute("CREATE INDEX IF NOT EXISTS idx_email_otps_email ON public.email_otps (email, created_at DESC);")
    await c.execute("""
        CREATE TABLE IF NOT EXISTS public.auth_sessions (
            id              BIGSERIAL PRIMARY KEY,
            token_hash      TEXT        UNIQUE NOT NULL,
            user_uid        TEXT        NOT NULL,
            expires_at      TIMESTAMPTZ NOT NULL,
            revoked         BOOLEAN     NOT NULL DEFAULT FALSE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)
    await c.execute("CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON public.auth_sessions (user_uid, expires_at DESC);")
    # Finalize any old active sessions left open in Supabase from a prior crash
    await c.execute("""
        UPDATE public.vehicle_sessions
        SET is_active = FALSE,
            ended_at = COALESCE(ended_at, updated_at, started_at),
            duration_s = GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(ended_at, updated_at, started_at) - started_at))),
            off_reason = COALESCE(off_reason, 'Server Restarted'),
            updated_at = NOW()
        WHERE is_active = TRUE;
    """)
    db["schema_ready"] = True


async def _sync_sessions_to_pg(c):
    # Pick up queued UIDs + any unsynced rows from SQLite
    uids = []
    while session_sync_queue:
        u = session_sync_queue.popleft()
        if u not in uids:
            uids.append(u)
    try:
        with _sqlite_conn() as conn:
            unsynced = conn.execute("SELECT session_uid FROM vehicle_sessions WHERE synced = 0 LIMIT 25").fetchall()
            for r in unsynced:
                if r["session_uid"] not in uids:
                    uids.append(r["session_uid"])
            for uid in uids:
                row = conn.execute("SELECT * FROM vehicle_sessions WHERE session_uid = ?", (uid,)).fetchone()
                if not row:
                    continue
                s_dt = datetime.fromtimestamp(float(row["started_at"]), tz=timezone.utc)
                e_dt = datetime.fromtimestamp(float(row["ended_at"]), tz=timezone.utc) if row["ended_at"] is not None else None
                await c.execute("""
                    INSERT INTO public.vehicle_sessions (
                        session_uid, device_id, started_at, ended_at, duration_s,
                        is_active, on_reason, off_reason, telemetry_summary, telemetry_samples, updated_at
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,NOW())
                    ON CONFLICT (session_uid) DO UPDATE SET
                        ended_at = EXCLUDED.ended_at,
                        duration_s = EXCLUDED.duration_s,
                        is_active = EXCLUDED.is_active,
                        off_reason = EXCLUDED.off_reason,
                        telemetry_summary = EXCLUDED.telemetry_summary,
                        telemetry_samples = EXCLUDED.telemetry_samples,
                        updated_at = NOW()
                """,
                    row["session_uid"], row["device_id"], s_dt, e_dt, float(row["duration_s"] or 0),
                    bool(row["is_active"]), row["on_reason"], row["off_reason"],
                    row["telemetry_summary"] or "{}", row["telemetry_samples"] or "[]"
                )
                if not row["is_active"]:
                    conn.execute("UPDATE vehicle_sessions SET synced = 1 WHERE session_uid = ?", (uid,))
            conn.commit()
    except Exception as e:
        print("[session-sync-pg]", type(e).__name__, e)


async def db_writer():
    last_nodes = 0
    last_count = 0
    while True:
        await asyncio.sleep(2)
        if not DB_URL: continue
        try:
            if db["pool"] is None:
                db["pool"] = await asyncpg.create_pool(DB_URL, ssl="require", min_size=1, max_size=2, statement_cache_size=0)
            async with db["pool"].acquire() as c:
                await _ensure_db_schema(c)
                batch = [pending.popleft() for _ in range(min(300, len(pending)))]
                try:
                    groups = {}
                    for t, row in batch:
                        if t in TABLES: groups.setdefault((t, tuple(row)), []).append(tuple(row.values()))
                    for (t, cols), rows in groups.items():
                        ph = ",".join(f"${i + 1}" for i in range(len(cols)))
                        await c.executemany(f"INSERT INTO public.{t} ({','.join(cols)}) VALUES ({ph})", rows)
                except Exception:
                    pending.extendleft(reversed(batch)); raise
                await _sync_sessions_to_pg(c)
                if time.time() - last_nodes > 5:
                    last_nodes = time.time()
                    for k, d in devs.items():
                        await c.execute("""INSERT INTO public.device_nodes (node_id,updated_at,title,proto,ip,status,latency_ms,packet_rate,signal)
                            VALUES ($1,NOW(),$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (node_id) DO UPDATE SET updated_at=NOW(),
                            ip=EXCLUDED.ip,status=EXCLUDED.status,latency_ms=EXCLUDED.latency_ms,packet_rate=EXCLUDED.packet_rate,signal=EXCLUDED.signal""",
                            k, NODES[k][0], NODES[k][1], d["ip"] or "-", status(d), int(d["rtt"] or 0), int(rate(d)), f"{d['rssi']} dBm")
                if time.time() - last_count > 10:
                    last_count = time.time()
                    try:
                        db["records"] = await c.fetchval("SELECT COUNT(*) FROM public.telemetry_logs") or 0
                    except Exception:
                        pass
            db["ok"] = True
        except Exception as e:
            db["ok"] = False; print("[db]", type(e).__name__, e)
            await asyncio.sleep(5)


@app.on_event("startup")
async def startup():
    _init_sqlite()
    for f in (logger, watchdog, cam_loop, db_writer): asyncio.create_task(f())
    print("[aegis] dashboard: http://localhost:8000   ESPs -> ws://<this-laptop-ip>:8000/ws/<id>")


@app.on_event("shutdown")
async def shutdown():
    _end_session(time.time(), "Server Shutdown")
