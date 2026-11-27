# Aegis Rover Command - FastAPI backend

1. Supabase: run your existing schema migration once (SQL editor). Tables used: telemetry_logs, safety_alerts, device_nodes, vision_snapshots.
2. Settings live in `config/.env` (database, hotspot, thresholds). Hotspot: Windows, 2.4 GHz, laptop = 192.168.137.1.
3. Double-click `run.bat`  ->  dashboard at http://localhost:8000
4. Firmware is in `firmware/` with the hotspot already filled in. Change `config/.env`, then `python tools/apply_wifi.py` re-patches all sketches.
   Still needed in glove_esp.ino: `mainMac` = the MAC the main ESP prints at boot.
5. Windows Firewall: allow port 8000 (admin prompt): netsh advfirewall firewall add rule name="Aegis" dir=in action=allow protocol=TCP localport=8000

ESP protocol: ws://192.168.137.1:8000/ws/<main|glove|cam>, JSON {"device","seq","uptime_ms","rssi","data":{...}}.
The cloud can only set servo angle/mode, motor speed config and E-STOP (speed 0). It can never drive the motors.
