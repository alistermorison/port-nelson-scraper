import os
import re
import cv2
import requests
import numpy as np
from PIL import Image
from io import BytesIO
from supabase import create_client, Client

url: str = os.environ.get("SUPABASE_URL")
key: str = os.environ.get("SUPABASE_KEY")
supabase: Client = create_client(url, key)

IMG_URL = "https://web.portnelson.co.nz/Webcam/PNL_Situation.jpg"

ROIs = {
    "image_update": (690, 0, 950, 45),
    "pn_tide": (740, 550, 820, 580),
    "main_wharf_wind": (135, 110, 220, 135),
    "main_wharf_gust": (135, 160, 220, 185),
    "main_wharf_dir": (135, 210, 260, 235),
    "no2_pile_velocity": (155, 440, 235, 470),
    "no2_pile_dir": (155, 495, 250, 525),
    "fairway_tide": (900, 160, 970, 185),
    "fairway_wind": (900, 210, 970, 235),
    "fairway_gust": (900, 260, 970, 285),
    "fairway_dir": (900, 310, 970, 335)
}

def extract_text(img_obj, box, is_numeric=True):
    crop = img_obj.crop(box)
    open_cv_image = np.array(crop) 
    gray = cv2.cvtColor(open_cv_image, cv2.COLOR_RGB2GRAY)
    _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    
    import pytesseract
    text = pytesseract.image_to_string(thresh, config='--psm 7').strip()
    
    if is_numeric:
        match = re.search(r"[-+]?\d*\.\d+|\d+", text)
        return float(match.group()) if match else None
    return text

def main():
    response = requests.get(IMG_URL, headers={'User-Agent': 'Mozilla/5.0'})
    img = Image.open(BytesIO(response.content))
    
    data = {}
    for key, box in ROIs.items():
        is_num = not ("dir" in key or "update" in key)
        data[key] = extract_text(img, box, is_numeric=is_num)
    
    supabase.table("harbor_conditions").insert(data).execute()
    print("Logged Complete Data Record:", data)

if __name__ == "__main__":
    main()
