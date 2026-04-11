"""
calibrate_measurements.py

Measures text widths using PIL/Pillow (the same library OEL uses for rendering)
and prints results as JSON for comparison against opentype.js measurements.

Run inside the addon container via the calibration route:
  GET /api/oel/calibrate
"""
import json
import sys
import os
from PIL import ImageFont

FONTS_DIR = os.path.join(os.path.dirname(__file__), 'fonts')

# Same test cases as the Node.js side.
TEST_CASES = [
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'HENRI FANTIN-LATOUR',     'size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'GUSTAVE CAILLEBOTTE',     'size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'CAMILLE PISSARRO',         'size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'VINCENT VAN GOGH',         'size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'JEAN-BAPTISTE-CAMILLE COROT', 'size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'REMBRANDT VAN RIJN',       'size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'HENRI FANTIN-LATOUR',     'size': 24 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'GUSTAVE CAILLEBOTTE',     'size': 24 },
    { 'font': 'Roboto-Medium.ttf',        'text': 'French, 1836-1904',        'size': 16 },
    { 'font': 'Roboto-Regular.ttf',       'text': '(1841-1919)',              'size': 14 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'The Floor Scrapers',       'size': 26 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'A Sunday on La Grande Jatte', 'size': 26 },
]

results = []
for tc in TEST_CASES:
    font_path = os.path.join(FONTS_DIR, tc['font'])
    try:
        font = ImageFont.truetype(font_path, tc['size'])
        # getlength() is the PIL equivalent of getAdvanceWidth — returns float px width.
        width = font.getlength(tc['text'])
        results.append({
            'font': tc['font'],
            'text': tc['text'],
            'size': tc['size'],
            'pil_width': round(width, 2),
        })
    except Exception as e:
        results.append({
            'font': tc['font'],
            'text': tc['text'],
            'size': tc['size'],
            'error': str(e),
        })

print(json.dumps(results))
