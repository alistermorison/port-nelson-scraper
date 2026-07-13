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

# Tight bounding boxes targeting ONLY the changing numeric/text values
ROIs = {
    "image_update": (690, 0, 950, 45),        # Keeping the full master date/time line
    
    # Port Nelson Tide
    "pn_tide": (740, 555, 815, 580),
    
    # Main Wharf
    "main_wharf_wind": (140, 110, 220, 135),
    "main_wharf_gust": (140, 160, 220, 185),
    "main_wharf_dir": (140, 210, 260, 235),
    
    # No 2 Pile
    "no2_pile_velocity": (155, 440, 235, 470),
    "no2_pile_dir": (155, 495, 250, 525),
    
    # Fairway Beacon
    "fairway_tide": (900, 160, 970, 185),
    "fairway_wind": (900, 210, 970, 235),
    "fairway_gust": (900, 260, 970, 285),
    "fairway_dir": (900, 310, 970, 335)
}

def extract_numeric(img, box):
    crop = img.crop(box)
    open_cv_image = np.array(crop) 
    gray = cv2.cvtColor(open_cv_image, cv2.COLOR_RGB2GRAY)
    
    # Upscale significantly to make the small digits crisp
    gray = cv2.resize(gray, (0, 0), fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    
    import pytesseract
    # CRITICAL CONFIG: Whitelist ONLY numbers and decimals. Treat as a single word line.
    custom_config = r'--psm 7 -c tessedit_char_whitelist=0123456789.'
    text = pytesseract.image_to_string(thresh, config=custom_config).strip()
    
    # Clean up and force to float
    match = re.search(r"\d*\.\d+|\d+", text)
    return float(match.group()) if match else None

def extract_text(img, box):
    # Used for direction markers (e.g. WNW) and timestamps
    crop = img.crop(box)
    open_cv_image = np.array(crop) 
    gray = cv2.cvtColor(open_cv_image, cv2.COLOR_RGB2GRAY)
    gray = cv2.resize(gray, (0, 0), fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    
    import pytesseract
    return pytesseract.image_to_string(thresh, config='--psm 7').strip()

def main():
    response = requests.get(IMG_URL, headers={'User-Agent': 'Mozilla/5.0'})
    img = Image.open(BytesIO(response.content))
    
    data = {
        "image_update": extract_text(img, ROIs["image_update"]),
        "pn_tide": extract_numeric(img, ROIs["pn_tide"]),
        "main_wharf_wind": extract_numeric(img, ROIs["main_wharf_wind"]),
        "main_wharf_gust": extract_numeric(img, ROIs["main_wharf_gust"]),
        "main_wharf_dir": extract_text(img, ROIs["main_wharf_dir"]),
        "no2_pile_velocity": extract_numeric(img, ROIs["no2_pile_velocity"]),
        "no2_pile_dir": extract_text(img, ROIs["no2_pile_dir"]),
        "fairway_tide": extract_numeric(img, ROIs["fairway_tide"]),
        "fairway_wind": extract_numeric(img, ROIs["fairway_wind"]),
        "fairway_gust": extract_numeric(img, ROIs["fairway_gust"]),
        "fairway_dir": extract_text(img, ROIs["fairway_dir"])
    }
    
    supabase.table("harbor_conditions").insert(data).execute()
    print("Logged targeted numeric entry successfully:", data)

if __name__ == "__main__":
    main()
