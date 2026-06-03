"""Morningstar PDF report organizer with OCR + Claude extraction."""

import asyncio
import base64
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

import pdfplumber

logger = logging.getLogger(__name__)


def extract_ticker_via_ocr(pdf_path: Path) -> Optional[str]:
    """Extract ticker from Morningstar PDF using OCR + regex."""
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            # Extract text from first 3 pages (ticker is near the top)
            text = ""
            for page in pdf.pages[:3]:
                extracted = page.extract_text()
                if extracted:
                    text += extracted + "\n"

            if not text:
                logger.warning(f"No text extracted from {pdf_path.name}")
                return None

            # Regex patterns for ticker extraction (Morningstar-specific)
            patterns = [
                # Morningstar format: "Company Name TICKER Q/QQQQ"
                r"[\s\n]([A-Z]{1,5})\s+Q{1,4}(?:\s|$|\n)",
                # Standard formats
                r"\b([A-Z]{1,5})\s+\(",  # "NVDA ("
                r"Ticker[:\s]+([A-Z]{1,5})",  # "Ticker: NVDA"
                r"\(([A-Z]{1,5})\)",  # "(NVDA)"
                r"Symbol[:\s]+([A-Z]{1,5})",  # "Symbol: NVDA"
                # Company Name TICKER format
                r"\s([A-Z]{1,5})\s(?:Inc|Corp|LLC|Ltd|Ltd\.|Co|Co\.)",
            ]

            candidates = []
            for pattern in patterns:
                matches = re.findall(pattern, text)
                candidates.extend(matches)

            # Filter to unique, valid candidates (1-5 chars, all uppercase)
            # Exclude common non-ticker abbreviations
            excluded = {"UTC", "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "INR", "SGD", "HKD", "CNY"}

            valid_candidates = []
            seen = set()
            for candidate in candidates:
                candidate = candidate.upper().strip()
                if (1 <= len(candidate) <= 5
                    and candidate.isalpha()
                    and candidate not in seen
                    and candidate not in excluded):
                    valid_candidates.append(candidate)
                    seen.add(candidate)

            if valid_candidates:
                logger.debug(f"OCR candidates for {pdf_path.name}: {valid_candidates}")
                # Return first candidate if we have exactly one, or if the first one appears multiple times
                if len(valid_candidates) == 1:
                    return valid_candidates[0]
                elif valid_candidates and valid_candidates[0] in [c for c in candidates if c not in excluded]:
                    return valid_candidates[0]

    except Exception as e:
        logger.error(f"OCR extraction failed for {pdf_path.name}: {e}")

    return None


async def extract_ticker_via_claude(
    pdf_path: Path, hint: Optional[str] = None
) -> Optional[str]:
    """Use Claude-Haiku to extract ticker from PDF."""
    try:
        import anthropic

        client = anthropic.Anthropic()

        # Read PDF as base64
        with open(pdf_path, "rb") as f:
            pdf_bytes = base64.b64encode(f.read()).decode()

        prompt = f"""Read this Morningstar research PDF and extract the stock ticker symbol.
Return ONLY the ticker (e.g., "NVDA", "MU", "GOOG"), nothing else.

{"Hint: The company is " + hint if hint else ""}"""

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=10,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "document",
                            "source": {
                                "type": "base64",
                                "media_type": "application/pdf",
                                "data": pdf_bytes,
                            },
                        },
                        {
                            "type": "text",
                            "text": prompt,
                        },
                    ],
                }
            ],
        )

        ticker = response.content[0].text.strip().upper()
        logger.debug(f"Claude extracted ticker: {ticker}")
        return ticker

    except Exception as e:
        logger.error(f"Claude extraction failed for {pdf_path.name}: {e}")
        return None


def ask_user_for_ticker(pdf_name: str, candidates: list[str]) -> Optional[str]:
    """Ask user to confirm or clarify ticker extraction."""
    if len(candidates) == 1:
        response = input(
            f"OCR found ticker: {candidates[0]} in {pdf_name}\n"
            f"Is this correct? (y/n/clarify): "
        ).lower().strip()
        if response == "y":
            return candidates[0]
        elif response == "clarify":
            return None  # Will trigger Claude fallback
        else:
            return None
    elif len(candidates) > 1:
        print(f"Ambiguous candidates for {pdf_name}: {', '.join(candidates)}")
        response = input("Enter ticker or 'clarify' or 'claude': ").upper().strip()
        if response in ["CLARIFY", "CLAUDE"]:
            return None  # Will trigger Claude fallback
        else:
            return response if response else None
    return None


async def organize_report(
    pdf_path: Path,
    target_dir: Path,
    archive_dir: Path,
    error_dir: Path,
    interactive: bool = True,
) -> Optional[str]:
    """Organize a single report. Returns the ticker if successful."""
    pdf_name = pdf_path.name

    # Step 1: Try OCR extraction
    ocr_ticker = extract_ticker_via_ocr(pdf_path)

    if ocr_ticker:
        ticker = ocr_ticker
        logger.info(f"OCR: {pdf_name} → {ticker}")
    else:
        # Step 2: Ask user interactively if OCR failed
        print(f"\nOrganizing: {pdf_name}")
        user_input = (
            input("OCR couldn't extract ticker. Enter ticker or 'claude': ").upper().strip()
        )

        if user_input.lower() == "claude":
            ticker = await extract_ticker_via_claude(pdf_path)
            if not ticker:
                print("Claude also couldn't extract ticker.")
                user_choice = (
                    input("Move to error/ or skip? (error/skip): ").lower().strip()
                )
                if user_choice == "error":
                    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                    error_path = error_dir / f"unknown-{timestamp}.pdf"
                    pdf_path.rename(error_path)
                    logger.info(f"Moved to error/: {error_path.name}")
                return None
        elif user_input:
            ticker = user_input
        else:
            print("Skipped.")
            return None

    # Step 3: Create files
    ticker = ticker.upper()
    today = datetime.now().strftime("%Y%m%d")

    # Latest working copy (no date)
    latest_path = target_dir / f"{ticker}-morningstar.pdf"
    latest_path.write_bytes(pdf_path.read_bytes())

    # Dated archive copy
    archived_path = archive_dir / f"{ticker}-{today}-morningstar.pdf"
    archived_path.write_bytes(pdf_path.read_bytes())

    # Remove from staging
    pdf_path.unlink()

    logger.info(f"✓ Organized: {pdf_name} → {ticker}")
    logger.info(f"  Created: {latest_path.name}")
    logger.info(f"  Archived: {archived_path.name}")

    return ticker


async def organize_reports(
    staging_dir: Path = None,
    target_dir: Path = None,
    archive_dir: Path = None,
    error_dir: Path = None,
    interactive: bool = True,
) -> dict:
    """Organize all PDFs in staging folder."""
    if staging_dir is None:
        staging_dir = Path("fstack/reports/staging")
    if target_dir is None:
        target_dir = Path("fstack/reports")
    if archive_dir is None:
        archive_dir = Path("fstack/reports/archive")
    if error_dir is None:
        error_dir = Path("fstack/reports/error")

    # Ensure directories exist
    for d in [staging_dir, target_dir, archive_dir, error_dir]:
        d.mkdir(parents=True, exist_ok=True)

    # Find PDFs in staging
    pdf_files = list(staging_dir.glob("*.pdf"))

    if not pdf_files:
        logger.info("No PDFs found in staging folder.")
        return {"success": [], "failed": []}

    print(f"\nFound {len(pdf_files)} PDF(s) in staging folder")

    # Process each PDF
    results = {"success": [], "failed": []}

    for pdf_path in pdf_files:
        try:
            ticker = await organize_report(
                pdf_path, target_dir, archive_dir, error_dir, interactive
            )
            if ticker:
                results["success"].append(ticker)
            else:
                results["failed"].append(pdf_path.name)
        except Exception as e:
            logger.error(f"Error processing {pdf_path.name}: {e}")
            results["failed"].append(pdf_path.name)

    # Print summary
    print("\n" + "=" * 60)
    print("Report Organization Summary")
    print("=" * 60)
    if results["success"]:
        print(f"✓ Successfully organized: {', '.join(results['success'])}")
    if results["failed"]:
        print(f"✗ Failed: {', '.join(results['failed'])}")
    print("=" * 60)

    return results
