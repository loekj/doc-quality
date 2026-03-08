#!/usr/bin/env python3
"""
Evaluate a trained doc-quality model against the held-out test set.

Reads the test-set.json (image paths) and features.csv, then scores
each test image using the trained model bundle and reports metrics.

Usage:
    python scripts/eval-model.py
    python scripts/eval-model.py --input-dir ./training --model ./models/quality-models.json
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score


def evaluate(y_true, y_pred, threshold=0.5, name='model'):
    """Compute regression and classification metrics."""
    y_pred = np.clip(y_pred, 0, 1)

    mae = mean_absolute_error(y_true, y_pred)
    rmse = np.sqrt(mean_squared_error(y_true, y_pred))
    r2 = r2_score(y_true, y_pred)

    true_pass = y_true >= threshold
    pred_pass = y_pred >= threshold
    accuracy = np.mean(true_pass == pred_pass)
    tp = int(np.sum(true_pass & pred_pass))
    tn = int(np.sum(~true_pass & ~pred_pass))
    fp = int(np.sum(~true_pass & pred_pass))
    fn = int(np.sum(true_pass & ~pred_pass))

    print(f'\n  {name} (n={len(y_true)}):')
    print(f'    R²={r2:.3f}  MAE={mae:.3f}  RMSE={rmse:.3f}')
    print(f'    Pass/fail accuracy: {accuracy:.1%}  (TP={tp} TN={tn} FP={fp} FN={fn})')

    # Per-tier breakdown
    tier_bounds = [(0, 0.25, 'very-bad'), (0.25, 0.5, 'bad'), (0.5, 0.75, 'good'), (0.75, 1.01, 'very-good')]
    for lo, hi, tier_name in tier_bounds:
        mask = (y_true >= lo) & (y_true < hi)
        if mask.sum() == 0:
            continue
        tier_mae = mean_absolute_error(y_true[mask], y_pred[mask])
        tier_acc = np.mean((y_pred[mask] >= threshold) == (y_true[mask] >= threshold))
        print(f'      {tier_name:>9}: MAE={tier_mae:.3f}  acc={tier_acc:.1%}  n={mask.sum()}')

    # Worst predictions
    errors = np.abs(y_true - y_pred)
    worst_idx = np.argsort(errors)[-5:][::-1]

    return {
        'r2': round(r2, 4),
        'mae': round(mae, 4),
        'rmse': round(rmse, 4),
        'accuracy': round(float(accuracy), 4),
        'confusion': {'tp': tp, 'tn': tn, 'fp': fp, 'fn': fn},
        'n_test': len(y_true),
    }, worst_idx


def eval_xgb_trees(trees, base_score, features):
    """Evaluate our JSON tree format (mirrors src/tree-eval.ts)."""
    score = base_score
    for tree_group in trees:
        for tree in tree_group:
            score += eval_tree(tree, features)
    return max(0, min(1, score))


def eval_tree(node, features):
    """Recursively evaluate a single tree node."""
    if 'leaf' in node:
        return node['leaf']

    feat_idx = node['split']
    threshold = node['split_condition']
    val = features[feat_idx] if feat_idx < len(features) else float('nan')

    if np.isnan(val):
        return eval_tree(node['right'] if node.get('missing', 1) else node['left'], features)
    if val <= threshold:
        return eval_tree(node['left'], features)
    return eval_tree(node['right'], features)


FAST_FEATURES = [
    'megapixels', 'width', 'height', 'aspectRatio', 'fileSize',
    'bpp', 'brightnessAvg', 'brightnessStdevMax',
    'laplacianStdev', 'laplacianMean', 'laplacianVariance', 'edgeRatio',
    'dpi', 'isJpeg', 'presetIdx',
]

ALL_FEATURES = FAST_FEATURES + [
    'foregroundRatio',
    'sharpnessRatioTopBot', 'brightnessDiffTopBot',
    'shadowEdgeCenterDiff', 'centerBrightness', 'edgeBrightness',
    'backgroundP90', 'skewAngle', 'colorSaturation',
    'fftHighFreqRatio', 'fftSpectralPeaks', 'fftJpegBlockiness',
    'zoneBrightnessDiff', 'zoneSharpnessRatio', 'directionalEnergyRatio',
    'zoneBrightness0', 'zoneBrightness1', 'zoneBrightness2', 'zoneBrightness3',
    'zoneSharpness0', 'zoneSharpness1', 'zoneSharpness2', 'zoneSharpness3',
    'channelCount',
]


def main():
    parser = argparse.ArgumentParser(description='Evaluate doc-quality model on test set')
    parser.add_argument('--input-dir', default='training', help='Directory with features.csv and test-set.json')
    parser.add_argument('--model', default='models/quality-models.json', help='Model bundle to evaluate')
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    model_path = Path(args.model)

    # Load test set paths
    test_paths_file = input_dir / 'test-set.json'
    if not test_paths_file.exists():
        print(f"No test set found at {test_paths_file}. Run train-model.py first.")
        sys.exit(1)

    test_paths = set(json.loads(test_paths_file.read_text()))
    print(f"Test set: {len(test_paths)} images")

    # Load features
    csv_path = input_dir / 'features.csv'
    if not csv_path.exists():
        print(f"No features CSV at {csv_path}")
        sys.exit(1)

    df = pd.read_csv(csv_path)
    test_df = df[df['path'].isin(test_paths)].copy()
    print(f"Test rows: {len(test_df)} ({len(test_df[test_df['mode'] == 'fast'])} fast, "
          f"{len(test_df[test_df['mode'] == 'thorough'])} thorough)")

    # Load model bundle
    with open(model_path) as f:
        bundle = json.load(f)

    print(f"\nModel: {model_path}")
    print(f"Available models: {', '.join(sorted(bundle.keys()))}")

    all_metrics = {}

    for mode, feature_cols in [('fast', FAST_FEATURES), ('thorough', ALL_FEATURES)]:
        if mode not in bundle:
            continue

        mode_df = test_df[test_df['mode'] == mode]
        if len(mode_df) == 0:
            continue

        model_def = bundle[mode]
        X = mode_df[feature_cols].copy().replace([np.inf, -np.inf, ''], np.nan).astype(float)
        y_true = mode_df['label'].values

        # Score each row using our tree evaluator
        y_pred = np.array([
            eval_xgb_trees(model_def['trees'], model_def['base_score'], row.values)
            for _, row in X.iterrows()
        ])

        result, worst_idx = evaluate(y_true, y_pred, name=mode)
        all_metrics[mode] = result

        # Show worst predictions
        print(f'\n    Worst predictions:')
        for idx in worst_idx:
            row = mode_df.iloc[idx]
            pred = y_pred[idx]
            print(f'      {row["path"]}: label={row["label"]:.2f} pred={pred:.2f} '
                  f'err={abs(row["label"] - pred):.2f}')

    # Write metrics
    metrics_path = Path(args.model).parent / 'metrics.json'
    with open(metrics_path, 'w') as f:
        json.dump({'models': all_metrics, 'n_test_images': len(test_paths)}, f, indent=2)
    print(f"\nMetrics written to {metrics_path}")


if __name__ == '__main__':
    main()
