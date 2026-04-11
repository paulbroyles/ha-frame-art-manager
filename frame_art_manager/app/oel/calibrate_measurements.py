"""
calibrate_measurements.py

Measures text widths using PIL/Pillow (the same library OEL uses for rendering)
and prints results as JSON for comparison against opentype.js measurements.

Run inside the addon container via the calibration route:
  GET /api/oel/calibrate
"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

FONTS_DIR = os.path.join(os.path.dirname(__file__), 'fonts')

# Same test cases as the Node.js side.
TEST_CASES = [
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'HENRI FANTIN-LATOUR',        'size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'GUSTAVE CAILLEBOTTE',        'size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'CAMILLE PISSARRO',           'size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'VINCENT VAN GOGH',           'size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'JEAN-BAPTISTE-CAMILLE COROT','size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'REMBRANDT VAN RIJN',         'size': 30 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'HENRI FANTIN-LATOUR',        'size': 24 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'GUSTAVE CAILLEBOTTE',        'size': 24 },
    { 'font': 'Roboto-Medium.ttf',        'text': 'French, 1836-1904',          'size': 16 },
    { 'font': 'Roboto-Regular.ttf',       'text': '(1841-1919)',                'size': 14 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'The Floor Scrapers',         'size': 26 },
    { 'font': 'PlayfairDisplay-Bold.ttf', 'text': 'A Sunday on La Grande Jatte','size': 26 },
]

# Create a dummy draw context — OEL uses draw.textlength(), not font.getlength().
# These can differ because draw.textlength() accounts for the rendering context.
img  = Image.new('RGB', (1, 1))
draw = ImageDraw.Draw(img)

results = []
for tc in TEST_CASES:
    font_path = os.path.join(FONTS_DIR, tc['font'])
    try:
        font = ImageFont.truetype(font_path, tc['size'])
        draw_width = draw.textlength(tc['text'], font=font)
        font_width = font.getlength(tc['text'])
        results.append({
            'font':       tc['font'],
            'text':       tc['text'],
            'size':       tc['size'],
            'draw_textlength': round(draw_width, 2),   # what OEL actually uses
            'font_getlength':  round(font_width, 2),   # what first calibration measured
        })
    except Exception as e:
        results.append({
            'font':  tc['font'],
            'text':  tc['text'],
            'size':  tc['size'],
            'error': str(e),
        })

print(json.dumps(results))
