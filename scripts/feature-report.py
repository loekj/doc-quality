#!/usr/bin/env python3
"""
Rank features by how well they separate good documents from bad ones.

Answers the two questions that were deferred until real labels existed:

  1. Are the advisory analyzers worth keeping as features? Four signals were
     demoted because they fire on provably good documents — colorDepth,
     fftMoire, directionalBlur and the character-shape check. Demoting them
     was a judgement about *gating*, not about whether they carry signal.
     This measures the signal.

  2. Where should the thresholds that were left uncalibrated actually sit?
     zoneSharpnessMinRatio and brightnessMax both sit where ordinary pages
     land, so scores jump between 1.00 and 0.70 on identical content.

Reads training/features.csv (from extract-features.mjs).

Usage:
    python scripts/feature-report.py
    python scripts/feature-report.py --mode deep --labeled-only
    python scripts/feature-report.py --threshold 0.5 --input training/features.csv
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Features a threshold is applied to, and which side counts as bad. Reporting a
# suggested cut only makes sense for these.
THRESHOLD_FEATURES = {
    'megapixels': ('low', 'resolutionMin'),
    'fileSize': ('low', 'fileSizeMin'),
    'bpp': ('low', 'compressionBppMin'),
    'brightnessAvg': ('both', 'brightnessMin / brightnessMax'),
    'laplacianStdev': ('low', 'sharpnessMin'),
    'edgeRatio': ('both', 'edgeDensityMin / edgeDensityMax'),
    'foregroundRatio': ('both', 'contrastMin / contrastMax'),
    'dpi': ('low', 'dpiMin'),
    'backgroundP90': ('low', 'backgroundP90Min'),
    'skewAngle': ('high', 'skewAngleMax'),
    'shadowEdgeCenterDiff': ('high', 'shadowBrightnessDiff'),
    'zoneBrightnessDiff': ('high', 'zoneBrightnessMaxDiff'),
    'zoneSharpnessRatio': ('low', 'zoneSharpnessMinRatio'),
    'fftHighFreqRatio': ('both', 'fftBlurHighFreqMin / fftNoiseHighFreqMax'),
    'fftSpectralPeaks': ('high', 'fftMoirePeaksMax'),
    'fftJpegBlockiness': ('high', 'fftJpegGridMax'),
    'directionalEnergyRatio': ('high', 'directionalBlurRatioMax'),
    'colorSaturation': ('low', 'colorSaturationMin'),
    'textBaselineDeviation': ('high', 'baselineDeviationMax'),
    'textCharSizeCV': ('high', 'charSizeCVMax'),
    'textCharShapeCV': ('high', 'charShapeCVMax'),
    'textMedianXHeight': ('low', 'textXHeightMin'),
    'textMedianStrokeWidth': ('low', 'textStrokeWidthMin'),
    'textMedianLineContrast': ('low', 'textLineContrastMin'),
    'textMedianStrokeSharpness': ('low', 'textStrokeSharpnessMin'),
    'textIllegibleFraction': ('high', 'textIllegibleFractionMax'),
}

# Below this many images in the smaller class, separation scores say more about
# the sample than the feature.
MIN_CLASS_FOR_CONFIDENCE = 30

# The signals demoted to advisory. Their verdict is the point of this report.
ADVISORY_FEATURES = {
    'colorSaturation': 'colorDepth / grayscale-in-color',
    'fftSpectralPeaks': 'fftMoire',
    'directionalEnergyRatio': 'directionalBlur',
    'textCharShapeCV': 'textGeometry / distorted-char-shapes',
}


def auc(values: np.ndarray, is_good: np.ndarray) -> float:
    """Rank-based AUC. 0.5 means no separation; distance from 0.5 is signal."""
    mask = np.isfinite(values)
    v, g = values[mask], is_good[mask]
    if len(np.unique(g)) < 2 or len(v) < 4:
        return float('nan')
    order = np.argsort(v, kind='mergesort')
    ranks = np.empty(len(v), float)
    ranks[order] = np.arange(1, len(v) + 1)
    # Average ranks within ties, or ties inflate the score.
    _, inv, counts = np.unique(v, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, weights=ranks)
    ranks = (sums / counts)[inv]
    n_good = int(g.sum())
    n_bad = len(g) - n_good
    if n_good == 0 or n_bad == 0:
        return float('nan')
    return (ranks[g].sum() - n_good * (n_good + 1) / 2) / (n_good * n_bad)


def best_split(values: np.ndarray, is_good: np.ndarray) -> tuple[float, float]:
    """The single cut that best separates good from bad, and its accuracy."""
    mask = np.isfinite(values)
    v, g = values[mask], is_good[mask]
    if len(v) < 4 or len(np.unique(v)) < 2:
        return float('nan'), float('nan')
    candidates = np.unique(np.quantile(v, np.linspace(0.02, 0.98, 49)))
    best_cut, best_acc = float('nan'), 0.0
    for cut in candidates:
        for below_is_good in (True, False):
            pred = (v <= cut) if below_is_good else (v > cut)
            acc = float((pred == g).mean())
            if acc > best_acc:
                best_acc, best_cut = acc, float(cut)
    return best_cut, best_acc


def main() -> None:
    ap = argparse.ArgumentParser(description='Rank features by label separation')
    ap.add_argument('--input', default='training/features.csv')
    ap.add_argument('--mode', default=None, choices=['fast', 'thorough', 'deep'],
                    help='Only rows from this mode (default: the richest mode present)')
    ap.add_argument('--threshold', type=float, default=0.5,
                    help='Label at or above this counts as good (default: 0.5)')
    ap.add_argument('--labeled-only', action='store_true',
                    help='Drop rows whose label came from a tier default')
    ap.add_argument('--top', type=int, default=20)
    args = ap.parse_args()

    path = Path(args.input)
    if not path.exists():
        print(f'No CSV at {path}. Run: node scripts/extract-features.mjs')
        sys.exit(1)

    df = pd.read_csv(path)
    if 'labelSource' in df.columns:
        human = int((df['labelSource'] == 'human').sum())
        print(f'{len(df)} rows, {human} from human scores, {len(df) - human} from tier defaults')
        if args.labeled_only:
            df = df[df['labelSource'] == 'human']
    else:
        print(f'{len(df)} rows (no labelSource column — provenance unknown)')

    mode = args.mode
    if mode is None:
        for candidate in ('deep', 'thorough', 'fast'):
            if (df['mode'] == candidate).any():
                mode = candidate
                break
    df = df[df['mode'] == mode]
    if len(df) < 8:
        print(f'Only {len(df)} rows in mode "{mode}" — too few to say anything.')
        sys.exit(1)

    is_good = (df['label'].to_numpy() >= args.threshold)
    n_good, n_bad = int(is_good.sum()), int((~is_good).sum())
    print(f'\nMode: {mode}   good (label >= {args.threshold}): {n_good}   bad: {n_bad}')

    # With few images almost anything separates perfectly, and a table full of
    # AUC 1.000 reads like certainty rather than the overfitting it is.
    smallest = min(n_good, n_bad)
    if smallest < MIN_CLASS_FOR_CONFIDENCE:
        print()
        print(f'  WARNING: only {smallest} images in the smaller class.')
        print('  Separation scores are unreliable below about '
              f'{MIN_CLASS_FOR_CONFIDENCE} per class — near-perfect AUCs here')
        print('  reflect sample size, not signal. Treat this as a smoke test.')
    print()

    feature_cols = [c for c in df.columns
                    if c not in {'path', 'category', 'preset', 'mode', 'label', 'labelSource'}]

    rows = []
    for col in feature_cols:
        values = pd.to_numeric(df[col], errors='coerce').to_numpy(float)
        coverage = float(np.isfinite(values).mean())
        if coverage == 0:
            rows.append((col, float('nan'), 0.0, float('nan'), float('nan')))
            continue
        a = auc(values, is_good)
        cut, acc = best_split(values, is_good)
        rows.append((col, a, coverage, cut, acc))

    # |AUC - 0.5| is the separation, regardless of direction.
    rows.sort(key=lambda r: (0 if np.isnan(r[1]) else abs(r[1] - 0.5)), reverse=True)

    print(f'{"feature":<30}{"AUC":>7}{"sep":>7}{"cover":>8}{"best cut":>12}{"acc":>7}')
    print('-' * 71)
    for col, a, cov, cut, acc in rows[:args.top]:
        sep = abs(a - 0.5) if not np.isnan(a) else float('nan')
        print(f'{col:<30}{a:>7.3f}{sep:>7.3f}{cov:>7.0%}{cut:>12.4g}{acc:>7.0%}')

    print(f'\n--- the four demoted signals ---')
    print('Demotion was about gating, not about signal. Separation near 0 means')
    print('the feature carries nothing and could be dropped entirely; clear')
    print('separation means it earns its place in the vector.')
    for col, label in ADVISORY_FEATURES.items():
        match = next((r for r in rows if r[0] == col), None)
        if match is None:
            print(f'  {label:<40} not in this CSV')
            continue
        _, a, cov, cut, acc = match
        if np.isnan(a):
            print(f'  {label:<40} no usable values (coverage {cov:.0%})')
        else:
            reliable = min(n_good, n_bad) >= MIN_CLASS_FOR_CONFIDENCE
            if not reliable:
                verdict = 'too few images to judge'
            else:
                verdict = 'carries signal' if abs(a - 0.5) >= 0.1 else 'little to no signal'
            print(f'  {label:<40} AUC {a:.3f}  sep {abs(a - 0.5):.3f}  {verdict}')

    print(f'\n--- suggested cuts for threshold-backed features ---')
    print('The value that best separates good from bad on this data. Compare')
    print('against the current default before changing anything: a cut that')
    print('barely beats chance is noise, not calibration.')
    print(f'{"feature":<30}{"threshold":<40}{"cut":>10}{"acc":>7}')
    print('-' * 87)
    for col, a, cov, cut, acc in rows:
        if col not in THRESHOLD_FEATURES or np.isnan(cut):
            continue
        _, name = THRESHOLD_FEATURES[col]
        print(f'{col:<30}{name:<40}{cut:>10.4g}{acc:>7.0%}')


if __name__ == '__main__':
    main()
