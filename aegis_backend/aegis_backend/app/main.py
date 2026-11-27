"""Aegis Rover Command - FastAPI backend.
ESPs  -> ws://<laptop>:8000/ws/<main|glove|cam>      (same JSON protocol as before)
Browser-> http://localhost:8000  (dashboard)  +  ws://localhost:8000/ws/dashboard
Data   -> Supabase tables telemetry_logs, safety_alerts, device_nodes, vision_snapshots (batched, retried)."""
import asyncio, json, os, time, urllib.request
from collections import deque
from pathlib import Path

import asyncpg
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / "config" / ".env")
E = os.getenv
START_TIME = time.time()
DB_URL = E("DATABASE_URL", "")
UNIT = E("UNIT_ID", "GLOVEDRIVE-ESP32-01")
CAMERA_STREAM_URL = E("CAMERA_STREAM_URL", "")
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
db = {"pool": None, "ok": False, "records": 0}
cool, state = {}, {"estop": False, "prev": (60, 60), "jpg": None, "jpg_t": 0, "alert_seq": 0}
app = FastAPI(title="Aegis Rover Command")

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
    alerts.appendleft({**row, "id": state["alert_seq"], "acked": False, "t": time.time()})
    pending.append(("safety_alerts", row))


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
                front_dist_cm=min(int(m.get("distance_cm", 999)), 999),
                temp_c=float(m.get("temp_c") or 0), humidity_pct=float(m.get("hum_pct") or 0),
                gas_raw=int(m.get("gas_raw", 0)), rssi_dbm=int(devs["main"]["rssi"] or 0),
                hazard_score=hazard(), person_detected=False, emergency_stop=state["estop"])


def on_message(name, text):
    d, now = devs[name], time.time()
    try: msg = json.loads(text)
    except ValueError: return
    d["last"] = now
    if msg.get("type") == "pong":
        t0 = d["pings"].pop(msg.get("n"), None)
        if t0: d["rtt"] = round((time.perf_counter() - t0) * 1000, 1)
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
    if d["rssi"] is not None and d["rssi"] < RSSI_MIN: alert("rssi-" + name, "ELEVATED", "LINK", f"{name} signal weak ({d['rssi']} dBm)")


@app.websocket("/ws/{name}")
async def ws_endpoint(ws: WebSocket, name: str):
    await ws.accept()
    if name == "dashboard": return await dashboard(ws)
    if name not in devs: return await ws.close()
    d = devs[name]
    d.update(ws=ws, ip=ws.client.host if ws.client else None, last=time.time(), seq=None)
    d["conns"] += 1

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
        if d["ws"] is ws: d["ws"] = None


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
                nodes=[dict(id=k, title=NODES[k][0], proto=NODES[k][1], ip=d["ip"], status=status(d), rate=rate(d),
                            rtt=d["rtt"], rssi=d["rssi"], lost=d["lost"], conns=d["conns"], data=d["data"])
                       for k, d in devs.items()],
                alerts=[{**a} for a in list(alerts)[:30]], cam=bool(state["jpg"]))


async def dashboard(ws):
    async def sender():
        while True:
            await ws.send_text(json.dumps(snapshot())); await asyncio.sleep(0.25)
    task = asyncio.create_task(sender())
    try:
        while True:
            try: await run_cmd(json.loads(await ws.receive_text()))
            except HTTPException as e: await ws.send_text(json.dumps({"error": e.detail}))
    except Exception: pass
    finally: task.cancel()


class Cmd(BaseModel):
    payload: dict


@app.post("/api/command")
async def api_command(c: Cmd):
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
def api_status(): return snapshot()


@app.get("/api/history")
def api_history(): return list(hist)


@app.post("/api/alerts/{alert_id}/ack")
def api_ack_alert(alert_id: int):
    for a in alerts:
        if a.get("id") == alert_id:
            a["acked"] = True
            return {"acked": True, "id": alert_id}
    raise HTTPException(404, "alert not found")


@app.get("/api/cam-status")
@app.get("/api/camera/status")
def api_cam_status():
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
async def api_camera_stream():
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
def latest():
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
            if s != "ONLINE" and last.get(k) == "ONLINE": alert("down-" + k, "ELEVATED", "LINK", f"{NODES[k][0]} is {s}")
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
    for f in (logger, watchdog, cam_loop, db_writer): asyncio.create_task(f())
    print("[aegis] dashboard: http://localhost:8000   ESPs -> ws://<this-laptop-ip>:8000/ws/<id>")
