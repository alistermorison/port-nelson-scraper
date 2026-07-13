import os
import re
import cv2
import requests
import numpy as np
from PIL import Image
from io import BytesIO
from supabase import create_client, Client

# Initialize database connection
url: str = os.environ.get("SUPABASE_URL")
key: str = os.environ.get("SUPABASE_KEY")
supabase: Client = create_client(url, key)

IMG_URL = "https://web.portnelson.co.nz/Webcam/PNL_Situation.jpg"

# Tight horizontal row strips to ensure lines don't get mixed up or dropped
ROIs = {
    "image_update": (690, 0, 950, 45),
    
    # Port Nelson Tide
    "pn_tide": (665, 550, 850, 595),
    
    # Main Wharf
    "main_wharf_wind": (5, 110, 250, 145),
    "main_wharf_gust": (5, 160, 250, 195),
    "main_wharf_dir": (5, 210, 270, 245),
    
    # No 2 Pile
    "no2_pile_velocity": (30, 440, 250, 480),
    "no2_pile_dir": (30, 490, 250, 530),
    
    # Fairway Beacon
    "fairway_tide": (500, 160, 970, 200),
    "fairway_wind": (500, 210, 970, 250),
    "fairway_gust": (500, 260, 970, 300),
    "fairway_dir": (500, 310, 970, 350)
}

def extract_clean_text(img, box):
    crop = img.crop(box)
    open_cv_image = np.array(crop) 
    gray = cv2.cvtColor(open_cv_image, cv2.COLOR_RGB2GRAY)
    
    # Scale up the strip to help the OCR engine read small fonts clearly
    gray = cv2.resize(gray, (0, 0), fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    
    # Clean up background noise using standard thresholding
    _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    
    import pytesseract
    return pytesseract.image_to_string(thresh, config='--psm 7').strip()

def main():
    response = requests.get(IMG_URL, headers={'User-Agent': 'Mozilla/5.0'})
    img = Image.open(BytesIO(response.content))
    
    # Gather raw OCR text from the fixed strips
    raw_text = {}
    for key, box in ROIs.items():
        raw_text[key] = extract_clean_text(img, box)
        
    # Helper extractors
    def parse_float(text):
        match = re.search(r"[-+]?\d*\.\d+|\d+", text)
        return float(match.group()) if match else None

    def parse_dir(text):
        # Finds direction indicators like 289 WNW or 137 SE
        match = re.search(r"(\d+\s*[A-Z]+)", text)
        return match.group(1) if match else None

    # Compile the final data row layout
    data = {
        "image_update": raw_text["image_update"],
        "pn_tide": parse_float(raw_text["pn_tide"]),
        "main_wharf_wind": parse_float(raw_text["main_wharf_wind"]),
        "main_wharf_gust": parse_float(raw_text["main_wharf_gust"]),
        "main_wharf_dir": parse_dir(raw_text["main_wharf_dir"]),
        "no2_pile_velocity": parse_float(raw_text["no2_pile_velocity"]),
        "no2_pile_dir": parse_dir(raw_text["no2_pile_dir"]),
        "fairway_tide": parse_float(raw_text["fairway_tide"]),
        "fairway_wind": parse_float(raw_text["fairway_wind"]),
        "fairway_gust": parse_float(raw_text["fairway_gust"]),
        "fairway_dir": parse_dir(raw_text["fairway_dir"])
    }
    
    # Save the polished row into your table
    supabase.table("harbor_conditions").insert(data).execute()
    print("Logged data successfully:", data)

if __name__ == "__main__":
    main()
