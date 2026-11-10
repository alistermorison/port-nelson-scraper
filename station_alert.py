"""Open a GitHub issue when a station on the Port Nelson image has been faulty for
an hour, and close it when the station recovers.

scraper.py stores nulls for a station whose numbers are red (Port Nelson's data
error marker) or stuck. When a station has had no reading for ALERT_FRAMES frames
in a row, this opens one issue titled "Station fault: <station>", which GitHub
emails to the repo owner. The issue includes a note to send to Port Nelson. When a
reading comes back, the issue gets a comment and is closed.
"""
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import requests
from urllib.parse import urlencode, quote
from supabase import create_client

from_env = os.environ.get
supabase = create_client(from_env("SUPABASE_URL"), from_env("SUPABASE_KEY"))
REPO = from_env("REPO")
NOTIFY = from_env("NOTIFY", "")
GH = {"Authorization": f"Bearer {from_env('GH_TOKEN')}", "Accept": "application/vnd.github+json"}
API = f"https://api.github.com/repos/{REPO}"
ALERT_FRAMES = int(from_env("ALERT_FRAMES", "12"))  # 12 frames = about 1 hour
NZ = ZoneInfo("Pacific/Auckland")

# Station name on the image, and the column that is null while it is faulty.
STATIONS = {
    "Main Wharf": ("Main Wharf: Wind", "main_wharf_wind"),
    "Fairway Beacon": ("Fairway Beacon: Wave & Wind", "fairway_wind"),
    "No 2 Pile": ("No 2 Pile: Current Meter", "no2_pile_velocity"),
}


def nz_time(iso):
    t = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(NZ)
    return t.strftime("%-d %b %Y at %H:%M")


def latest_frames(cols, n):
    rows = (supabase.table("harbor_conditions").select(",".join(["image_update", "created_at"] + cols))
            .order("created_at", desc=True).limit(n * 3).execute().data)
    frames, seen = [], set()
    for r in rows:
        if r["image_update"] not in seen:
            seen.add(r["image_update"])
            frames.append(r)
    return frames[:n]


def last_good(col):
    rows = (supabase.table("harbor_conditions").select("created_at").not_.is_(col, "null")
            .order("created_at", desc=True).limit(1).execute().data)
    return rows[0]["created_at"] if rows else None


def open_issues():
    r = requests.get(f"{API}/issues", headers=GH, params={"state": "open", "per_page": 100})
    r.raise_for_status()
    return {i["title"]: i["number"] for i in r.json() if "pull_request" not in i}


def email_note(name, label, since):
    return f"""To: info@portnelson.co.nz
Subject: {name} readings on the harbour conditions image

Hello,

I follow the harbour conditions image on your website (web.portnelson.co.nz/Webcam/PNL_Situation.jpg). The {label} readings have been shown in red, or have not changed, since about {since} NZ time, while the rest of the image is updating normally. It looks like that sensor or its data feed has stopped.

Could you please pass this on to whoever looks after the instruments?

Many thanks,
Alister Morison"""


def mailto(name, label, since):
    lines = email_note(name, label, since).split("\n")
    subject = lines[1].removeprefix("Subject: ")
    body = "\n".join(lines[3:])
    return "mailto:info@portnelson.co.nz?" + urlencode({"subject": subject, "body": body}, quote_via=quote)


def main():
    cols = [c for _, c in STATIONS.values()]
    frames = latest_frames(cols, ALERT_FRAMES)
    issues = open_issues()
    for name, (label, col) in STATIONS.items():
        title = f"Station fault: {name}"
        faulty = len(frames) == ALERT_FRAMES and all(f[col] is None for f in frames)
        number = issues.get(title)
        if faulty and not number:
            good = last_good(col)
            since = nz_time(good) if good else "an unknown time"
            body = (f"@{NOTIFY} Port Nelson's image has shown no usable {name} reading for the last "
                    f"{ALERT_FRAMES} frames (about {ALERT_FRAMES * 5} minutes). The last good reading was "
                    f"on {since} NZ time. The scraper is storing blanks for {name} until it recovers, "
                    f"and this issue closes itself when it does.\n\n"
                    f"A note you could email to Port Nelson "
                    f"([open it in your email app]({mailto(name, label, since)})):\n\n"
                    f"```\n{email_note(name, label, since)}\n```\n")
            r = requests.post(f"{API}/issues", headers=GH, json={"title": title, "body": body})
            r.raise_for_status()
            print(f"Opened #{r.json()['number']}: {title}")
        elif number and frames and frames[0][col] is not None:
            when = nz_time(frames[0]["created_at"])
            requests.post(f"{API}/issues/{number}/comments", headers=GH,
                          json={"body": f"{name} is reading again ({when} NZ time). Closing this alert."}).raise_for_status()
            requests.patch(f"{API}/issues/{number}", headers=GH, json={"state": "closed"}).raise_for_status()
            print(f"{name} recovered, closed #{number}")


if __name__ == "__main__":
    main()
