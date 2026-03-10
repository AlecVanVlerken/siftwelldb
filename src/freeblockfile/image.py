from PIL import Image, ImageDraw, ImageFont
import random

# Constants
BLOCK_SIZE = 80
BLOCK_MARGIN = 10
GRID_COLS = 5
GRID_ROWS = 4
NUM_BLOCKS = GRID_COLS * GRID_ROWS

ZOOMED_WIDTH = 600
ZOOMED_HEIGHT = 100
BYTE_WIDTH = ZOOMED_WIDTH // 32

COLORS = {
    'block_type': (255, 165, 0),
    'first_free': (50, 205, 50),
    'root_block': (65, 105, 225),
    'unused_start': (200, 200, 200),
    'unused_end': (240, 240, 240),
    'border': (0, 0, 0),
    'label': (0, 0, 0),
    'header_outline': (255, 0, 0)
}

# Font setup
try:
    font = ImageFont.truetype("arial.ttf", 14)
except:
    font = ImageFont.load_default()

# Image dimensions
image_width = GRID_COLS * (BLOCK_SIZE + BLOCK_MARGIN) + BLOCK_MARGIN
image_height = GRID_ROWS * (BLOCK_SIZE + BLOCK_MARGIN) + BLOCK_MARGIN + ZOOMED_HEIGHT + 50
img = Image.new("RGB", (image_width, image_height), color="white")
draw = ImageDraw.Draw(img)

# Assign block labels
block_labels = ['Header'] + [random.choice(["Free", "Data"]) for _ in range(NUM_BLOCKS - 1)]

# Draw blocks
for i in range(NUM_BLOCKS):
    row, col = divmod(i, GRID_COLS)
    x0 = BLOCK_MARGIN + col * (BLOCK_SIZE + BLOCK_MARGIN)
    y0 = BLOCK_MARGIN + row * (BLOCK_SIZE + BLOCK_MARGIN)
    x1 = x0 + BLOCK_SIZE
    y1 = y0 + BLOCK_SIZE

    draw.rectangle([x0, y0, x1, y1], outline=COLORS['border'], width=2)
    label = block_labels[i]
    w, h = draw.textsize(label, font=font)
    draw.text((x0 + (BLOCK_SIZE - w) // 2, y0 + (BLOCK_SIZE - h) // 2), label, fill="black", font=font)

    if i == 0:
        draw.rectangle([x0 - 2, y0 - 2, x1 + 2, y1 + 2], outline=COLORS['header_outline'], width=2)

# Draw zoomed-in header block
zoom_x0 = BLOCK_MARGIN
zoom_y0 = image_height - ZOOMED_HEIGHT - BLOCK_MARGIN
zoom_x1 = zoom_x0 + ZOOMED_WIDTH
zoom_y1 = zoom_y0 + ZOOMED_HEIGHT
draw.rectangle([zoom_x0, zoom_y0, zoom_x1, zoom_y1], outline=COLORS['border'], width=2)

# Draw byte layout
for i in range(32):
    byte_x0 = zoom_x0 + i * BYTE_WIDTH
    byte_x1 = byte_x0 + BYTE_WIDTH

    if i == 0:
        fill = COLORS['block_type']
    elif 1 <= i <= 8:
        fill = COLORS['first_free']
    elif 9 <= i <= 16:
        fill = COLORS['root_block']
    else:
        # Gradient
        ratio = (i - 17) / (32 - 17)
        r = int(COLORS['unused_start'][0] * (1 - ratio) + COLORS['unused_end'][0] * ratio)
        g = int(COLORS['unused_start'][1] * (1 - ratio) + COLORS['unused_end'][1] * ratio)
        b = int(COLORS['unused_start'][2] * (1 - ratio) + COLORS['unused_end'][2] * ratio)
        fill = (r, g, b)

    draw.rectangle([byte_x0, zoom_y0, byte_x1, zoom_y1], fill=fill, outline=COLORS['border'])

# Add labels above sections
def add_label(text, start_byte, end_byte, color):
    x0 = zoom_x0 + start_byte * BYTE_WIDTH
    x1 = zoom_x0 + (end_byte + 1) * BYTE_WIDTH
    cx = (x0 + x1) // 2
    cy = zoom_y0 - 18
    draw.line([(cx, zoom_y0), (cx, cy + 10)], fill=color, width=2)
    w, h = draw.textsize(text, font=font)
    draw.text((cx - w // 2, cy - h // 2), text, fill=color, font=font)

add_label("Block Type", 0, 0, COLORS['block_type'])
add_label("First Free Block Pointer", 1, 8, COLORS['first_free'])
add_label("Root Block Pointer", 9, 16, COLORS['root_block'])

# Save and show
img.save("header_block_visual.png")
img.show()
