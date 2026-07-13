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

# 2. Define data structure schema
class HarborConditions(BaseModel):
    image_update: str = Field(description="The timestamp string found in the top right corner (e.g. 10/07/2026 15:16 ST)")
    pn_tide: float = Field(description="The Port Nelson: Tide value as a decimal float")
    main_wharf_wind: float = Field(description="The Main Wharf: Wind value as a decimal float")
    main_wharf_gust: float = Field(description="The Main Wharf: Gust value as a decimal float")
    main_wharf_dir: str = Field(description="The Main Wharf: Direction string (e.g. 289 WNW)")
    no2_pile_velocity: float = Field(description="The No 2 Pile: Velocity value as a decimal float")
    no2_pile_dir: str = Field(description="The No 2 Pile: Direction string (e.g. 137 SE)")
    fairway_tide: float = Field(description="The Fairway Beacon: Tide value as a decimal float")
    fairway_wind: float = Field(description="The Fairway Beacon: Wind value as a decimal float")
    fairway_gust: float = Field(description="The Fairway Beacon: Gust value as a decimal float")
    fairway_dir: str = Field(description="The Fairway Beacon: Direction string (e.g. 341 NNW)")

def main():
    response = requests.get(IMG_URL, headers={'User-Agent': 'Mozilla/5.0'})
    img = Image.open(BytesIO(response.content))
    
    prompt = "Analyze this harbor condition dashboard display image and extract every active numeric value and text data point specified in the schema output structure."
    
    response = ai_client.models.generate_content(
        model='gemini-2.5-flash-latest',
        contents=[img, prompt],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=HarborConditions,
            temperature=0.0
        ),
    )
    
    data = json.loads(response.text)
    
    supabase.table("harbor_conditions").insert(data).execute()
    print("AI Vision Scraper successfully logged entry:", data)

if __name__ == "__main__":
    main()
