# Real File Test Fixtures

Drop real files into the appropriate category and quality tier.
The directory name maps directly to test expectations.

## Categories

| Directory     | Preset     | Description                                      |
| ------------- | ---------- | ------------------------------------------------ |
| `documents/`  | `document` | Full-page docs — contracts, tax forms, invoices   |
| `receipts/`   | `receipt`  | Thermal paper receipts, POS printouts             |
| `cards/`      | `card`     | ID cards, driver's licenses, credit cards         |
| `photos/`     | `document` | General photos of documents, mixed content        |

## Quality Tiers

| Directory   | Expected Score | Pass? | Typical characteristics                          |
| ----------- | -------------- | ----- | ------------------------------------------------ |
| `very-good` | >= 0.9         | Yes   | Clean scan, high res, good lighting, no issues    |
| `good`      | >= 0.5, < 0.9  | Yes   | Acceptable quality, minor issues                  |
| `bad`       | >= 0.2, < 0.5  | No    | Noticeable problems — blurry, dark, skewed        |
| `very-bad`  | < 0.2          | No    | Unusable — blank, tiny, extremely blurry/dark     |

## Supported Formats

JPEG, PNG, TIFF, WebP, PDF

## Adding Files

1. Place the file in `<category>/<tier>/`
2. Tests auto-discover all files in these directories
3. File names should be descriptive (e.g. `blurry-phone-photo.jpg`, `300dpi-flatbed-scan.pdf`)
