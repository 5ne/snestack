# Morningstar Reports

This directory stores Morningstar research PDFs for equity analysis.

## Structure

```
reports/
├── {TICKER}-morningstar.pdf    # Individual ticker reports
├── {TICKER}-{DATE}.pdf          # Versioned reports
└── README.md
```

## Usage

Reports are automatically synced across machines via Git LFS. No manual setup needed after cloning.

### Downloading Reports

**Option 1: Manual (Current)**
1. Log into Schwab
2. Search for ticker in Research
3. Download Morningstar PDF to this directory

**Option 2: Automated (Coming Soon)**
Once Schwab API is approved, run:
```bash
npm run dev -- download-reports GOOG MU NVDA   # run from node/
```

## Parsing Reports

Use the Morningstar parser to extract metrics:
```python
from fstack.tools.morningstar_parser import MorningstarParser

parser = MorningstarParser("fstack/reports/MU-morningstar.pdf")
fair_value = parser.extract_fair_value()
pe_ratio = parser.extract_pe_ratio()
red_flags = parser.extract_red_flags()
```

## Git LFS

This directory uses Git Large File Storage (LFS) to efficiently track binary PDFs. Files are stored via `git lfs track "*.pdf"`.

When cloning or pulling:
```bash
git clone <repo>  # LFS files are downloaded automatically
```

If LFS files aren't syncing:
```bash
git lfs pull
```

## Keeping Reports Current

Morningstar updates estimates periodically. Consider re-downloading reports quarterly or when:
- Stock price changes >20%
- Company earnings miss/beat expectations significantly
- Major competitive or product news
