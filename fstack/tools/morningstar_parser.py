"""Parse fundamental data from Morningstar PDF reports."""

import logging
import re
from pathlib import Path
from typing import Optional

import pdfplumber

logger = logging.getLogger(__name__)


def _clean_number(s: str) -> Optional[float]:
    """Parse a number string, returning None for dashes or blanks."""
    s = s.strip().replace(",", "").replace("%", "")
    if s in ("—", "-", "", "N/A"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_morningstar_pdf(pdf_path: Path) -> dict:
    """Extract fundamental data from a Morningstar PDF.

    Parses the header summary (fair value, moat, rating) and the
    Financials section (revenue, FCF, growth rates, P/E, P/B).

    Returns a dict with keys matching EquityData fields plus
    Morningstar-specific extras (fair_value, price_to_fair_value,
    economic_moat, morningstar_rating, uncertainty, capital_allocation).
    Returns an empty dict if parsing fails.
    """
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            full_text = "\n".join(
                page.extract_text() or "" for page in pdf.pages
            )
    except Exception as e:
        logger.warning(f"Could not open {pdf_path.name}: {e}")
        return {}

    result = {}

    # --- Header line (appears on every page) ---
    # "Last Price Fair Value Estimate Price/FVE Market Cap Economic MoatTM ... Uncertainty Capital Allocation"
    # followed by: "211.14 USD 280.00 USD 0.75 5.42 USD Tril Wide 3Large Growth Very High Exemplary"
    header_match = re.search(
        r"Last Price\s+Fair Value Estimate\s+Price/FVE\s+Market Cap\s+Economic Moat.*?Capital Allocation\s+"
        r"([\d.]+)\s+USD\s+([\d.]+)\s+USD\s+([\d.]+)\s+([\d.]+)\s+USD\s+(?:Tril|Bil)?\s*"
        r"(Wide|Narrow|None)\s+.*?"
        r"(Very High|High|Medium|Low|Extreme)\s+"
        r"(Exemplary|Standard|Poor)",
        full_text,
        re.DOTALL,
    )
    if header_match:
        result["fair_value"] = _clean_number(header_match.group(2))
        result["price_to_fair_value"] = _clean_number(header_match.group(3))
        result["economic_moat"] = header_match.group(5)
        result["uncertainty"] = header_match.group(6)
        result["capital_allocation"] = header_match.group(7)

    # Morningstar star rating: count Q's after ticker on header line
    # e.g. "NVDA QQQQ" → 4 stars
    star_match = re.search(r"[A-Z]{1,5}\s+(Q{1,5})\b", full_text)
    if star_match:
        result["morningstar_rating"] = len(star_match.group(1))

    # --- P/E, P/B, Dividend Yield from comparables or valuation table ---
    # The comparables table has "Price/Earning  32.33  —  87.26  172.03"
    # We want the first (subject company) value.
    pe_match = re.search(
        r"Price/Earning\s+([\d,.]+|—)\s", full_text
    )
    if pe_match:
        result["pe_ratio"] = _clean_number(pe_match.group(1))

    pb_match = re.search(
        r"Price/Book\s+([\d,.]+|—)\s", full_text
    )
    if pb_match:
        result["pb_ratio"] = _clean_number(pb_match.group(1))

    div_match = re.search(
        r"Dividend Yield\s+([\d,.]+%|—)\s", full_text
    )
    if div_match:
        raw = div_match.group(1).replace("%", "").strip()
        val = _clean_number(raw)
        result["dividend_yield"] = val / 100.0 if val is not None else None

    # --- Financials section ---
    # "Revenue Growth %  100.1  125.9  114.2  65.5  80.1 ..."
    # The first number after the label is the 3-year CAGR; the actual years follow.
    # We want the most recent actual year's value (index 1 in the data row).
    rev_growth_match = re.search(
        r"Revenue Growth %\s+([\d.,-]+)\s+([\d.,-]+)", full_text
    )
    if rev_growth_match:
        val = _clean_number(rev_growth_match.group(2))
        result["revenue_growth"] = val / 100.0 if val is not None else None

    eps_growth_match = re.search(
        r"Earnings Per Share Growth %\s+([\d.,-]+)\s+([\d.,-]+)", full_text
    )
    if eps_growth_match:
        val = _clean_number(eps_growth_match.group(2))
        result["earnings_growth"] = val / 100.0 if val is not None else None

    # FCF (USD Mil) — most recent actual year (first value after label)
    fcf_match = re.search(
        r"Free Cash Flow To The Firm \(USD Mil\)\s+([\d,.]+)", full_text
    )
    if fcf_match:
        val = _clean_number(fcf_match.group(1))
        result["fcf"] = val * 1e6 if val is not None else None

    # FCF yield — look for "Free Cash Flow Yield %  X.X" in valuation block
    fcf_yield_match = re.search(
        r"Free Cash Flow Yield %\s+([\d.]+)", full_text
    )
    if fcf_yield_match:
        val = _clean_number(fcf_yield_match.group(1))
        result["fcf_yield"] = val / 100.0 if val is not None else None

    # Debt/equity not in Morningstar PDF summary — leave as None
    result.setdefault("debt_to_equity", None)

    logger.debug(f"Parsed {pdf_path.name}: {list(result.keys())}")
    return result


def find_report(ticker: str, reports_dir: Path) -> Optional[Path]:
    """Return the path to a ticker's Morningstar PDF, or None."""
    path = reports_dir / f"{ticker.upper()}-morningstar.pdf"
    return path if path.exists() else None
