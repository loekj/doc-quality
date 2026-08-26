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


## Where the images live

They are not in this repo and never were — `.gitignore` and `.railwayignore`
both exclude the category folders. The 5065 files listed in `manifest.json` are
served from S3:

```
https://doc-quality-labeling.s3.amazonaws.com/<category>/<tier>/<file>
```

Objects are publicly readable; listing the bucket root is not. The label server
streams from there when `S3_BUCKET_URL` is set, which is what the deployed
`Dockerfile` does, and reads from these folders otherwise.

## Where the labels live, and how not to lose them

`labels.json`, at `LABELS_PATH`. On Railway that is `/data/labels.json`, which
survives a redeploy **only if a volume is mounted there**. A container's
filesystem is discarded otherwise, and the file is the sole copy: it is not in
S3, and it has never been committed.

Three things guard against that now:

- The server says on startup whether the labels are on a volume, and warns
  loudly when they are not.
- Every save appends to `labels.jsonl` before rewriting `labels.json`, and the
  rewrite goes to a temp file and is renamed into place. An append cannot
  destroy what is already there; the previous plain write truncated the file
  first, so a crash mid-save took every label with it. If the snapshot is ever
  unreadable the server rebuilds it from the journal on the next start.
- `node scripts/backup-labels.mjs <server-url>` pulls the labels into this
  directory, merging rather than replacing so a local copy holding entries the
  server has since lost keeps them.

`.gitignore` already un-ignores `labels.json`. Committing it is the intended
destination, and the only copy that outlives the service.


## Scoring modes

The page offers two ways to score the same thing, switched by the button in the
top bar and remembered per device.

- **1-4** — four buttons, one press each, saving the band centres 0.12, 0.37,
  0.62 and 0.87. Fast enough to get through thousands of images.
- **0-100** — a slider and a Save button, which is what the earlier tool had and
  what the labels already in the file were graded on.

Both write an identical record and use the same band edges at 0.25, 0.50 and
0.75, so switching mid-session does not split the dataset into incompatible
halves. Existing labels load into either mode: the badge shows the stored tier
and the slider restores the exact stored score.

The difference is resolution, not format. A band press records one of four
values; the slider records any of a hundred. Whether that matters depends on
whether a rater is genuinely consistent at 0.01 resolution — `feature-report.py`
will show whether the finer labels separate anything the bands do not.

A skip records no score at all. It means "not judging this one", which is not
the same as zero, and `extract-features.mjs` drops entries without a score.
