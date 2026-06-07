"""Tests for the Morningstar PDF parser."""

import pytest
from pathlib import Path

from fstack.tools.morningstar_parser import _clean_number, find_report, parse_morningstar_pdf

REPORTS_DIR = Path("fstack/reports")


# ============================================================================
# _clean_number
# ============================================================================

@pytest.mark.unit
class TestCleanNumber:

    def test_simple_float(self):
        assert _clean_number("32.33") == 32.33

    def test_with_comma(self):
        assert _clean_number("1,234.56") == 1234.56

    def test_with_percent(self):
        assert _clean_number("75.5%") == 75.5

    def test_dash_returns_none(self):
        assert _clean_number("—") is None

    def test_hyphen_returns_none(self):
        assert _clean_number("-") is None

    def test_empty_string_returns_none(self):
        assert _clean_number("") is None

    def test_na_returns_none(self):
        assert _clean_number("N/A") is None

    def test_whitespace_stripped(self):
        assert _clean_number("  42.0  ") == 42.0

    def test_integer_string(self):
        assert _clean_number("100") == 100.0


# ============================================================================
# find_report
# ============================================================================

@pytest.mark.unit
class TestFindReport:

    def test_finds_existing_report(self, tmp_path):
        (tmp_path / "NVDA-morningstar.pdf").touch()
        assert find_report("NVDA", tmp_path) is not None

    def test_returns_none_for_missing_report(self, tmp_path):
        assert find_report("ZZZZZ", tmp_path) is None

    def test_case_insensitive_ticker(self, tmp_path):
        (tmp_path / "NVDA-morningstar.pdf").touch()
        assert find_report("nvda", tmp_path) is not None

    def test_returns_correct_path(self, tmp_path):
        (tmp_path / "AAPL-morningstar.pdf").touch()
        result = find_report("AAPL", tmp_path)
        assert result.name == "AAPL-morningstar.pdf"


# ============================================================================
# parse_morningstar_pdf — against real reports
# ============================================================================

@pytest.mark.integration
class TestParseMorningstarPdf:

    @pytest.fixture(autouse=True)
    def skip_if_no_reports(self):
        if not REPORTS_DIR.exists():
            pytest.skip("fstack/reports not present")

    def _parse(self, ticker):
        pdf = REPORTS_DIR / f"{ticker}-morningstar.pdf"
        if not pdf.exists():
            pytest.skip(f"No report for {ticker}")
        return parse_morningstar_pdf(pdf)

    def test_nvda_fair_value(self):
        data = self._parse("NVDA")
        assert data.get("fair_value") == 280.0

    def test_nvda_price_to_fair_value(self):
        data = self._parse("NVDA")
        assert data.get("price_to_fair_value") == 0.75

    def test_nvda_economic_moat(self):
        data = self._parse("NVDA")
        assert data.get("economic_moat") == "Wide"

    def test_nvda_morningstar_rating(self):
        data = self._parse("NVDA")
        assert data.get("morningstar_rating") == 4

    def test_nvda_pe_ratio(self):
        data = self._parse("NVDA")
        assert data.get("pe_ratio") == pytest.approx(32.33, abs=0.1)

    def test_nvda_fcf_positive(self):
        data = self._parse("NVDA")
        assert data.get("fcf") is not None
        assert data["fcf"] > 0

    def test_nvda_revenue_growth_positive(self):
        data = self._parse("NVDA")
        rg = data.get("revenue_growth")
        assert rg is not None
        assert rg > 0

    def test_msft_wide_moat(self):
        data = self._parse("MSFT")
        assert data.get("economic_moat") == "Wide"

    def test_msft_fair_value(self):
        data = self._parse("MSFT")
        assert data.get("fair_value") == 600.0

    def test_msft_capital_allocation(self):
        data = self._parse("MSFT")
        assert data.get("capital_allocation") == "Exemplary"

    def test_goog_wide_moat(self):
        data = self._parse("GOOG")
        assert data.get("economic_moat") == "Wide"

    def test_rivn_high_uncertainty(self):
        data = self._parse("RIVN")
        assert data.get("uncertainty") == "Very High"

    def test_rivn_fair_value(self):
        data = self._parse("RIVN")
        assert data.get("fair_value") == pytest.approx(20.0, abs=1.0)

    def test_mu_low_star_rating(self):
        data = self._parse("MU")
        assert data.get("morningstar_rating") == 1

    def test_mu_declining_revenue(self):
        data = self._parse("MU")
        rg = data.get("revenue_growth")
        assert rg is not None
        assert rg < 0

    def test_dell_fair_value(self):
        data = self._parse("DELL")
        assert data.get("fair_value") == pytest.approx(460.0, abs=5.0)

    def test_missing_pdf_returns_empty_dict(self, tmp_path):
        result = parse_morningstar_pdf(tmp_path / "FAKE-morningstar.pdf")
        assert result == {}

    def test_all_reports_parse_without_crash(self):
        for pdf in REPORTS_DIR.glob("*-morningstar.pdf"):
            result = parse_morningstar_pdf(pdf)
            assert isinstance(result, dict)

    def test_all_reports_have_pe_or_fair_value(self):
        parsed = []
        for pdf in REPORTS_DIR.glob("*-morningstar.pdf"):
            data = parse_morningstar_pdf(pdf)
            has_data = data.get("pe_ratio") is not None or data.get("fair_value") is not None
            parsed.append((pdf.stem, has_data))
        # At least 75% of reports should have PE or fair value
        success_rate = sum(1 for _, ok in parsed if ok) / len(parsed)
        assert success_rate >= 0.75, f"Too many failed parses: {[n for n, ok in parsed if not ok]}"
