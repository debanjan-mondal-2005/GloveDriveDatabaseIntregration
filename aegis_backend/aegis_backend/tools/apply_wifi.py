"""Copies WIFI_SSID / WIFI_PASS / HUB_HOST from config/.env into every firmware sketch.  Run: python tools/apply_wifi.py"""
import re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
env = dict(l.strip().split("=", 1) for l in (root / "config" / ".env").read_text().splitlines() if "=" in l and not l.startswith("#"))
for f in root.glob("firmware/*/*.ino"):
    s = f.read_text()
    for var, key in (("WIFI_SSID", "WIFI_SSID"), ("WIFI_PASS", "WIFI_PASS"), ("HUB_HOST", "HUB_HOST")):
        s = re.sub(rf'(\b{var}\s*=\s*)"[^"]*"', rf'\g<1>"{env[key]}"', s)
    f.write_text(s); print("patched", f.name)
