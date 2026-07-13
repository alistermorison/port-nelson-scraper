import os
import cv2
import requests
import numpy as np
from PIL import Image
from io import BytesIO

IMG_URL = "https://web.portnelson.co.nz/Webcam/PNL_Situation.jpg"

# Instead of tiny boxes, we take wide blocks covering the entire text groups
LARGE_BLOCKS = {
    "Top_Left_Main_Wharf": (0, 0, 300, 400),
    "Top_Middle_Shed_7": (250, 0, 550, 400),
    "Top_Right_Fairway": (500, 0, 950, 500),
    "Bottom_Left_Piles": (0, 380, 350, 750),
    "Bottom_Right_Tide": (600, 500, 950, 650)
}

def diagnose_block(img_obj, box, block_name):
    crop = img_obj.crop(box)
    open_cv_image = np.array(crop) 
    gray = cv2.cvtColor(open_cv_image, cv2.COLOR_RGB2GRAY)
    
    # Simple resizing to make the text larger and easier for OCR to read
    gray = cv2.resize(gray, (0, 0), fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    
    import pytesseract
    # PSM 6 tells Tesseract to treat the crop as a single uniform block of text
    text = pytesseract.image_to_string(gray, config='--psm 6').strip()
    
    print(f"\n--- DEBUG: {block_name} ---")
    print(text if text else "[NO TEXT FOUND]")
    print("----------------------------")

def main():
    print(f"Downloading live image from {IMG_URL}...")
    response = requests.get(IMG_URL, headers={'User-Agent': 'Mozilla/5.0'})
    img = Image.open(BytesIO(response.content))
    print(f"Image downloaded successfully. Original size: {img.size}")
    
    # Run diagnostics on the blocks
    for name, box in LARGE_BLOCKS.items():
        diagnose_block(img, box, name)

if __name__ == "__main__":
    main()
