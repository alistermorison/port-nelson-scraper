import time
from typing import Optional
import os
import json
import requests
from io import BytesIO
from PIL import Image
from google import genai
from google.genai import types
from pydantic import BaseModel, Field
from supabase import create_client, Client

# 1. Connect to Cloud Services
supabase_url: str = os.environ.get("SUPABASE_URL")
supabase_key: str = os.environ.get("SUPABASE_KEY")
supabase: Client = create_client(supabase_url, supabase_key)

gemini_key: str = os.environ.get("GEMINI_API_KEY")
ai_client = genai.Client(api_key=gemini_key)

IMG_URL = "https://web.portnelson.co.nz/Webcam/PNL_Situation.jpg"

# 2. Define data structure schema (Directions restricted to pure numeric integers)
class HarborConditions(BaseModel):
    image_update: str = Field(description="The timestamp string found in the top right corner (e.g. 10/07/2026 15:16 ST)")
    pn_tide: float = Field(description="The Port Nelson: Tide value as a decimal float")
    main_wharf_wind: float = Field(description="The Main Wharf: Wind value as a decimal float")
    main_wharf_gust: float = Field(description="The Main Wharf: Gust value as a decimal float")
    main_wharf_dir: int = Field(description="Extract ONLY the numeric degree integer for direction (e.g. extract 228 from '228 SW')")
    no2_pile_velocity: float = Field(description="The No 2 Pile: Velocity value as a decimal float")
    no2_pile_dir: int = Field(description="Extract ONLY the numeric degree integer for direction (e.g. extract 319 from '319 NW')")
    fairway_tide: float = Field(description="The Fairway Beacon: Tide value as a decimal float")
    fairway_wind: float = Field(description="The Fairway Beacon: Wind value as a decimal float")
    fairway_gust: float = Field(description="The Fairway Beacon: Gust value as a decimal float")
    fairway_dir: int = Field(description="Extract ONLY the numeric degree integer for direction (e.g. extract 177 from '177 S')")
    sig_wave_height: Optional[float] = Field(default=None, description="The significant wave height (Sig Wave Hgt / Hs) in metres as a decimal float, or null if not shown")
    h10_wave_height: Optional[float] = Field(default=None, description="The highest tenth wave height (Highest 10th Hgt / H1/10) in metres as a decimal float, or null if not shown")

# 3. Frozen sensor check
# Sometimes a station on the Port Nelson display stops updating while the rest of
# the image carries on (Main Wharf showed 9.6 kn, gust 12.3, 37 deg from
# 6 Nov 2026 for days). Gemini reads the stuck numbers correctly, so the rows look
# real. Real wind never repeats wind, gust and direction exactly for half an hour,
# so when a station's values match the last few stored readings exactly, store
# nulls for that station instead.
#
# Each station: its columns, and how many frames in a row (including this one) count
# as frozen. Current at No 2 Pile changes slowly in 0.1 kn steps, so it gets longer.
STATIONS = {
    "Main Wharf": (["main_wharf_wind", "main_wharf_gust", "main_wharf_dir"], 6),   # 30 min
    "Fairway Beacon": (["fairway_wind", "fairway_gust", "fairway_dir"], 6),      # 30 min
    "No 2 Pile": (["no2_pile_velocity", "no2_pile_dir"], 12),                    # 1 hour
}

def blank_frozen_stations(data):
    for name, (cols, frames) in STATIONS.items():
        current = [data.get(c) for c in cols]
        if any(v is None for v in current):
            continue
        # Latest stored readings for this station (rows already blanked are skipped,
        # so a long freeze stays blank until the numbers change).
        rows = (supabase.table("harbor_conditions")
                .select(",".join(["image_update"] + cols))
                .not_.is_(cols[0], "null")
                .order("created_at", desc=True)
                .limit(frames * 3)
                .execute().data)
        previous, seen = [], {data.get("image_update")}
        for r in rows:
            # Count each webcam frame once; a repeated frame is not a new reading.
            if r["image_update"] in seen:
                continue
            seen.add(r["image_update"])
            previous.append([r[c] for c in cols])
        previous = previous[:frames - 1]
        if len(previous) == frames - 1 and all(p == current for p in previous):
            print(f"{name} looks frozen at {current} for {frames} frames; storing nulls for it.")
            for c in cols:
                data[c] = None
    return data

def main():
    response = requests.get(IMG_URL, headers={'User-Agent': 'Mozilla/5.0'})
    img = Image.open(BytesIO(response.content))
    
    prompt = "Analyze this harbor condition dashboard display image and extract every active numeric value and text data point specified in the schema output structure."
    
    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = ai_client.models.generate_content(
                model='gemini-3.1-flash-lite',
                contents=[img, prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=HarborConditions,
                    temperature=0.0
                ),
            )
            break
        except Exception as e:
            if attempt < max_retries - 1:
                print(f"Gemini server is busy ({e}). Retrying in 15 seconds... (Attempt {attempt + 1}/{max_retries})")
                time.sleep(15)
            else:
                print("Max retries reached. Google servers are completely unavailable.")
                raise e

    data = json.loads(response.text)

    try:
        data = blank_frozen_stations(data)
    except Exception as e:
        # Never lose a reading because the check failed.
        print(f"Frozen sensor check failed ({e}); storing the values as read.")
    
    # Direction columns are integers in Supabase; wave heights may be null
    # if the image doesn't show them.
    supabase.table("harbor_conditions").insert(data).execute()
    print("AI Vision Scraper successfully logged entry with numeric degrees:", data)

if __name__ == "__main__":
    main()
