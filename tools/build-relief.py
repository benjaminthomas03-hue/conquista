"""Builds public/relief.jpg: real-world hill shading reprojected onto the game board.

Source: ETOPO1 shaded relief image (NOAA, public domain), as shipped in the basemap-data package.
The hill shading is extracted from the image (high-pass of log brightness, which removes the
elevation colour ramp and keeps the light/shadow of the terrain), then reprojected from
equirectangular onto the board's Miller projection. Mid-grey (128) means "no change".

Run:  pip install --break-system-packages basemap-data numpy pillow scipy
      python3 tools/build-relief.py
"""
import json, math, os, re, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import gaussian_filter, map_coordinates

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_W = 2400  # board is 1000 units wide -> 2.4 px per unit (sharp up to ~2x zoom)

def find_source():
    try:
        import mpl_toolkits.basemap_data as bd
        return os.path.join(list(bd.__path__)[0], 'etopo1.jpg')
    except ImportError:
        alt = os.environ.get('ETOPO_JPG')
        if alt and os.path.exists(alt):
            return alt
        sys.exit('Install basemap-data (pip) or set ETOPO_JPG to the etopo1.jpg path')

def main():
    geo = json.loads(subprocess.check_output(['node', '-e', "const g=require('./shared/map-geo.js');console.log(JSON.stringify({w:g.width,h:g.height,proj:g.proj,paths:g.paths}))"], cwd=ROOT))
    W, H, P = geo['w'], geo['h'], geo['proj']
    src = np.asarray(Image.open(find_source()).convert('RGB'), dtype=np.float32) / 255.0
    sh, sw, _ = src.shape
    r, g, b = src[..., 0], src[..., 1], src[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    loglum = np.log(np.clip(lum, 0.02, 1))
    # land mask from the colour ramp (sea is blue); ice caps (near white) count as land
    land = ((b < np.maximum(r, g) * 1.05) | (lum > 0.82)).astype(np.float32)
    land = gaussian_filter(land, 1.0) > 0.5

    def land_blur(a, sigma):
        # blur using land pixels only, so the land/sea colour jump doesn't create halos along coasts
        m = land.astype(np.float32)
        return gaussian_filter(a * m, sigma) / np.maximum(gaussian_filter(m, sigma), 1e-3)

    fine = loglum - land_blur(loglum, 5)           # ridges and valleys
    broad = land_blur(loglum, 5) - land_blur(loglum, 22)  # whole mountain ranges and plateaus
    relief = (fine + 0.55 * broad) * land
    relief = gaussian_filter(relief, sigma=0.5)
    land_src = land

    # board pixel -> lon/lat (inverse Miller, d3 conventions: y grows downwards, rotate[0] added to lon)
    out_h = round(OUT_W * H / W)
    xs = (np.arange(OUT_W) + 0.5) * W / OUT_W
    ys = (np.arange(out_h) + 0.5) * H / out_h
    X, Y = np.meshgrid(xs, ys)
    lam = (X - P['translate'][0]) / P['scale']
    ym = -(Y - P['translate'][1]) / P['scale']
    phi = 2.5 * np.arctan(np.exp(0.8 * ym)) - 0.625 * math.pi
    lon = np.degrees(lam) - P['rotate'][0]
    lon = (lon + 180) % 360 - 180
    lat = np.degrees(phi)
    col = (lon + 180) / 360 * sw - 0.5
    row = (90 - lat) / 180 * sh - 0.5
    sampled = map_coordinates(relief, [row, col], order=1, mode='wrap')
    on_land = map_coordinates(land_src.astype(np.float32), [row, col], order=1, mode='wrap') > 0.5

    # keep relief only on the game's own land shapes (drops islands that aren't part of any territory)
    mask_img = Image.new('L', (OUT_W, out_h), 0)
    draw = ImageDraw.Draw(mask_img)
    k = OUT_W / W
    for d in geo['paths'].values():
        for ring in re.findall(r'M([^MZ]+)Z?', d):
            nums = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', ring)]
            pts = [(nums[i] * k, nums[i + 1] * k) for i in range(0, len(nums) - 1, 2)]
            if len(pts) >= 3:
                draw.polygon(pts, fill=255)
    mask = np.asarray(mask_img.filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float32) / 255.0
    on_land &= mask > 0.5
    sampled = sampled * mask

    # normalise robustly (using land only) to mid-grey +- range
    scale = np.percentile(np.abs(sampled[on_land]), 98.5)
    img = np.clip(128 + 127 * sampled / scale, 0, 255).astype(np.uint8)
    out = os.path.join(ROOT, 'public', 'relief.jpg')
    Image.fromarray(img, 'L').save(out, quality=82, optimize=True, progressive=True)
    print(f'Wrote public/relief.jpg {OUT_W}x{out_h}, {os.path.getsize(out) // 1024} KB')

if __name__ == '__main__':
    main()
