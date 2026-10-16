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
    
    # Direction columns are integers in Supabase; wave heights may be null
    # if the image doesn't show them.
    supabase.table("harbor_conditions").insert(data).execute()
    print("AI Vision Scraper successfully logged entry with numeric degrees:", data)

if __name__ == "__main__":
    main()
