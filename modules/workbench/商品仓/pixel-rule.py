"""N22 local pixel-only silhouette rule. No data files, model weights or network."""
import io
import json
import sys
import warnings

import cv2 as cv
import numpy as np
from PIL import Image, ImageOps

RULE_ID = "n22-closed-loop"
RULE_VERSION = "1.0.0"
MAX_BYTES = 8 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 20_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
cv.setNumThreads(1)
cv.ocl.setUseOpenCL(False)
BASE = dict(ruleId=RULE_ID, ruleVersion=RULE_VERSION, runtime="OpenCV-" + cv.__version__)


def receipt(reason, features=None, category=None, decoded=True):
    return dict(BASE, category=category, reason=reason, decoded=decoded,
                confidence="heuristic_strong" if category else "insufficient",
                features=features or {})


def rgba(raw):
    # Reuses the in-house album/vision.mjs decode checks and downsampling design.
    with Image.open(io.BytesIO(raw)) as im:
        if im.format not in ("JPEG", "PNG", "WEBP") or im.width * im.height > Image.MAX_IMAGE_PIXELS or getattr(im, "n_frames", 1) != 1:
            raise ValueError("unsupported image")
        im.verify()
    with Image.open(io.BytesIO(raw)) as im:
        im = ImageOps.exif_transpose(im).convert("RGBA")
        im.thumbnail((512, 512), Image.Resampling.LANCZOS)
        return np.asarray(im)


def run(raw):
    try:
        a = rgba(raw)
    except (OSError, ValueError, Image.DecompressionBombWarning, Image.DecompressionBombError):
        return receipt("PIXEL_DECODE_REJECTED", decoded=False)
    h, w = a.shape[:2]
    if min(h, w) < 64:
        return receipt("PIXEL_TOO_SMALL")
    # Reuse album/vision.mjs features(): alpha or border Lab, open, dominant component.
    alpha = np.mean(a[:, :, 3] < 10) > .08
    f = {"foreground": "alpha" if alpha else "border_lab"}
    if alpha:
        m = a[:, :, 3] > 245
    else:
        lab = cv.cvtColor(np.ascontiguousarray(a[:, :, :3]), cv.COLOR_RGB2LAB).astype(np.float32)
        edge = np.concatenate([lab[:3].reshape(-1, 3), lab[-3:].reshape(-1, 3),
                               lab[:, :3].reshape(-1, 3), lab[:, -3:].reshape(-1, 3)])
        bg = np.median(edge, axis=0)
        spread = float(np.percentile(np.linalg.norm(edge - bg, axis=1), 95))
        f["borderP95"] = round(spread, 2)
        if spread > 22:
            return receipt("PIXEL_BACKGROUND_UNSTABLE", f)
        m = np.linalg.norm(lab - bg, axis=2) > max(20, spread + 12)
    m = cv.morphologyEx(m.astype(np.uint8), cv.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, ids, stats, _ = cv.connectedComponentsWithStats(m)
    if n < 2:
        return receipt("PIXEL_NO_FOREGROUND", f)
    i = 1 + int(np.argmax(stats[1:, cv.CC_STAT_AREA]))
    x, y, bw, bh, area = (int(v) for v in stats[i])
    f["dominantFraction"] = round(area / max(1, int(m.sum())), 3)
    if area < .02*h*w or area > .68*h*w or f["dominantFraction"] < .90:
        return receipt("PIXEL_NO_DOMINANT_OBJECT", f)
    if min(x, y, w - x - bw, h - y - bh) < max(4, int(.02*min(h,w))):
        return receipt("PIXEL_OBJECT_CROPPED", f)
    mask = (ids == i).astype(np.uint8)
    contours, hier = cv.findContours(mask, cv.RETR_CCOMP, cv.CHAIN_APPROX_NONE)
    ext = max((k for k, v in enumerate(hier[0]) if v[3] == -1), key=lambda k: cv.contourArea(contours[k]))
    whole = cv.contourArea(contours[ext])
    holes = sorted((cv.contourArea(contours[k]), k) for k, v in enumerate(hier[0]) if v[3] == ext)
    if not holes or whole <= 0:
        return receipt("PIXEL_NO_CLOSED_LOOP", f)
    hole_area, inner = holes[-1]
    f["holeFraction"] = round(hole_area/whole, 3)
    if not .28 <= hole_area/whole <= .78 or (len(holes)>1 and holes[-2][0] > .025*whole) or len(contours[inner]) < 5:
        return receipt("PIXEL_HOLE_GEOMETRY_UNCLEAR", f)
    (cx, cy), (ea, eb), _ = cv.fitEllipse(contours[inner])
    f["innerAxisRatio"] = round(min(ea,eb)/max(ea,eb,1), 3)
    if f["innerAxisRatio"] < .70 or np.hypot((cx-x-bw/2)/bw,(cy-y-bh/2)/bh) > .10:
        return receipt("PIXEL_LOOP_VIEW_AMBIGUOUS", f)
    steps = np.arange(np.ceil(np.hypot(bw,bh))+2)
    theta = np.arange(360)*(2*np.pi/360)
    px = np.clip(np.rint(cx+np.cos(theta)[:,None]*steps).astype(int),0,w-1)
    py = np.clip(np.rint(cy+np.sin(theta)[:,None]*steps).astype(int),0,h-1)
    ray = mask[py,px] != 0
    if not np.all(ray.any(axis=1)) or mask[int(round(cy)),int(round(cx))]:
        return receipt("PIXEL_LOOP_INCOMPLETE", f)
    outer = ray.shape[1]-1-np.argmax(ray[:,::-1],axis=1)
    inner_r = np.argmax(ray,axis=1)
    rim = outer-inner_r+1
    if float(np.percentile(1-ray.sum(axis=1)/rim,95)) > .14 or float(np.percentile(rim,5)) < 5:
        return receipt("PIXEL_RIM_OCCLUDED", f)
    freq = np.fft.rfft(outer/np.mean(outer))
    freq[:4] = 0 # remove low frequencies including oval tilt
    residual = np.fft.irfft(freq, n=len(outer))
    smooth = float(np.percentile(np.abs(residual),95))
    band = np.abs(freq[7:25])
    peak = 7+int(np.argmax(band))
    amplitude = 2*float(np.max(band))/len(outer)
    share = float(np.sum(np.abs(freq[peak-1:peak+2])**2)/max(1.e-8,np.sum(np.abs(freq)**2)))
    ratio = float(np.percentile(rim,90)/max(1,np.percentile(rim,10)))
    f.update(rimVariation=round(ratio,3), radialResidual=round(smooth,3), beadPeriod=peak,
             periodicAmplitude=round(amplitude,3), periodicEnergyShare=round(share,3))
    if amplitude >= .016 and share >= .57 and ratio >= 1.18:
        return receipt("PIXEL_PERIODIC_BEAD_OUTLINE", f, "bracelet")
    if smooth <= .023 and ratio <= 1.28 and .32 <= hole_area/whole <= .71:
        return receipt("PIXEL_SMOOTH_CLOSED_RIM", f, "bangle")
    return receipt("PIXEL_LOOP_PATTERN_UNCERTAIN", f)


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        print(json.dumps(BASE))
    elif len(sys.argv) == 1:
        data = sys.stdin.buffer.read(MAX_BYTES+1)
        print(json.dumps(run(data) if 0 < len(data) <= MAX_BYTES else receipt("PIXEL_BYTE_LIMIT", decoded=False), allow_nan=False))
    else:
        raise SystemExit(2)
