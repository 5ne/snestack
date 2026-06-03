"""fstack CLI entry point."""

import asyncio
import argparse
import logging
import sys
from pathlib import Path

from fstack import __version__
from fstack.config import get_config
from fstack.core.db import Database
from fstack.core.setup import setup_interactive, validate_env
from fstack.core.analysis import run_batch, run_single
from fstack.core.errors import ConfigError

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        prog="fstack",
        description="Personal investment decision-support system powered by Claude.",
    )

    parser.add_argument(
        "--version",
        action="version",
        version=f"fstack {__version__}",
    )

    parser.add_argument(
        "--db",
        default="fstack.db",
        help="Path to SQLite database (default: fstack.db)",
    )

    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable verbose logging",
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # Setup command
    setup_parser = subparsers.add_parser("setup", help="Interactive configuration")
    setup_parser.add_argument(
        "--env-file",
        default=".env",
        help="Path to .env file (default: .env)",
    )

    # Batch analysis command
    batch_parser = subparsers.add_parser("batch", help="Run batch analysis")
    batch_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Don't send email or store signals",
    )

    # Single ticker analysis command
    analyze_parser = subparsers.add_parser("analyze", help="Analyze single ticker")
    analyze_parser.add_argument(
        "ticker",
        help="Ticker symbol to analyze",
    )

    # Retry pending emails command
    retry_parser = subparsers.add_parser("retry", help="Retry pending notifications")

    # Position commands
    position_parser = subparsers.add_parser("position", help="Manage positions")
    position_subparsers = position_parser.add_subparsers(
        dest="position_cmd",
        help="Position command",
    )

    add_parser = position_subparsers.add_parser("add", help="Add position")
    add_parser.add_argument("ticker", help="Ticker symbol")
    add_parser.add_argument("shares", type=float, help="Number of shares")
    add_parser.add_argument("cost_basis", type=float, help="Average cost per share")
    add_parser.add_argument("--notes", default="", help="Position notes")

    list_parser = position_subparsers.add_parser("list", help="List positions")

    # Watchlist commands
    watchlist_parser = subparsers.add_parser("watchlist", help="Manage watchlist")
    watchlist_subparsers = watchlist_parser.add_subparsers(
        dest="watchlist_cmd",
        help="Watchlist command",
    )

    watch_add = watchlist_subparsers.add_parser("add", help="Add to watchlist")
    watch_add.add_argument("ticker", help="Ticker symbol")
    watch_add.add_argument("thesis", help="Investment thesis")
    watch_add.add_argument("--notes", default="", help="Watchlist notes")

    watch_list = watchlist_subparsers.add_parser("list", help="List watchlist")

    # Scheduler commands
    scheduler_parser = subparsers.add_parser("scheduler", help="Manage cron scheduling")
    scheduler_parser.add_argument(
        "--setup",
        action="store_true",
        help="Interactive cron setup",
    )
    scheduler_parser.add_argument(
        "--list",
        action="store_true",
        help="List installed crontab",
    )

    # Organize reports command
    organize_parser = subparsers.add_parser("organize-reports", help="Organize Morningstar PDFs from staging")
    organize_parser.add_argument(
        "--staging-dir",
        default="fstack/reports/staging",
        help="Staging directory (default: fstack/reports/staging)",
    )
    organize_parser.add_argument(
        "--target-dir",
        default="fstack/reports",
        help="Target reports directory (default: fstack/reports)",
    )
    organize_parser.add_argument(
        "--archive-dir",
        default="fstack/reports/archive",
        help="Archive directory (default: fstack/reports/archive)",
    )
    organize_parser.add_argument(
        "--error-dir",
        default="fstack/reports/error",
        help="Error directory (default: fstack/reports/error)",
    )

    # Parse arguments
    args = parser.parse_args()

    # Set logging level
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Handle commands
    if args.command == "setup":
        return cmd_setup(args)
    elif args.command == "batch":
        return cmd_batch(args)
    elif args.command == "analyze":
        return cmd_analyze(args)
    elif args.command == "retry":
        return cmd_retry(args)
    elif args.command == "position":
        return cmd_position(args)
    elif args.command == "watchlist":
        return cmd_watchlist(args)
    elif args.command == "scheduler":
        return cmd_scheduler(args)
    elif args.command == "organize-reports":
        return cmd_organize_reports(args)
    else:
        parser.print_help()
        return 1


def cmd_setup(args) -> int:
    """Setup command: interactive configuration."""
    try:
        success = setup_interactive(args.env_file)
        return 0 if success else 1
    except Exception as e:
        logger.error(f"Setup failed: {e}")
        return 1


def cmd_batch(args) -> int:
    """Batch analysis command."""
    try:
        # Check for staging files first
        staging_dir = Path("fstack/reports/staging")
        if staging_dir.exists():
            staging_files = list(staging_dir.glob("*.pdf"))
            if staging_files:
                print(f"\nFound {len(staging_files)} report(s) in staging folder.")
                response = input("Organize reports first? (y/n): ").lower().strip()
                if response == "y":
                    from fstack.tools.report_organizer import organize_reports

                    asyncio.run(
                        organize_reports(
                            staging_dir=staging_dir,
                            target_dir=Path("fstack/reports"),
                            archive_dir=Path("fstack/reports/archive"),
                            error_dir=Path("fstack/reports/error"),
                            interactive=True,
                        )
                    )

        # Validate config
        if not validate_env():
            return 1

        # Open database
        db = Database(args.db)

        # Run async analysis
        result = asyncio.run(run_batch(db, dry_run=args.dry_run))

        # Print results
        print("\n" + "=" * 60)
        print("Batch Analysis Results")
        print("=" * 60)
        print(f"Signals: {result.success_count}")
        print(f"Errors:  {result.error_count}")
        print(f"Time:    {result.duration_seconds:.1f}s")
        print("=" * 60)

        if result.signals:
            print("\nSignals:")
            for signal in result.signals:
                print(
                    f"  {signal.ticker:6} {signal.recommendation:6} "
                    f"({signal.confidence:.0%}) - {signal.reasoning[:50]}"
                )

        if result.errors:
            print("\nErrors:")
            for ticker, error in result.errors.items():
                print(f"  {ticker}: {error}")

        return 0 if result.error_count == 0 else 1

    except ConfigError as e:
        logger.error(f"Configuration error: {e}")
        print("Run 'fstack setup' to configure")
        return 1
    except Exception as e:
        logger.error(f"Batch analysis failed: {e}")
        return 1


def cmd_analyze(args) -> int:
    """Single ticker analysis command."""
    try:
        # Validate config
        if not validate_env():
            return 1

        # Open database
        db = Database(args.db)

        # Run async analysis
        signal = asyncio.run(run_single(db, args.ticker.upper()))

        # Print results
        print("\n" + "=" * 60)
        print(f"Analysis: {args.ticker.upper()}")
        print("=" * 60)

        if signal:
            print(f"Recommendation: {signal.recommendation}")
            print(f"Confidence:     {signal.confidence:.0%}")
            print(f"Reasoning:      {signal.reasoning}")
        else:
            print("Analysis failed or no data available")
            return 1

        print("=" * 60)
        return 0

    except ConfigError as e:
        logger.error(f"Configuration error: {e}")
        print("Run 'fstack setup' to configure")
        return 1
    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        return 1


def cmd_retry(args) -> int:
    """Retry pending notifications command."""
    try:
        # Validate config
        if not validate_env():
            return 1

        # Open database
        db = Database(args.db)

        # Import here to avoid circular dependency
        from fstack.agents.trader_agent import TraderAgent
        from fstack.config import get_config

        config = get_config()
        trader = TraderAgent(
            db=db,
            gmail_address=config.get_gmail_address(),
            gmail_app_password=config.get("FSTACK_GMAIL_APP_PASSWORD"),
            notification_email=config.get_notification_email(),
        )

        # Run async retry
        retried = asyncio.run(trader.retry_pending_notifications())

        print(f"\n✓ Retried {retried} pending notifications")
        return 0

    except ConfigError as e:
        logger.error(f"Configuration error: {e}")
        return 1
    except Exception as e:
        logger.error(f"Retry failed: {e}")
        return 1


def cmd_position(args) -> int:
    """Position management command."""
    try:
        db = Database(args.db)

        if args.position_cmd == "add":
            success = db.add_position(
                ticker=args.ticker.upper(),
                shares=args.shares,
                cost_basis=args.cost_basis,
                notes=args.notes or None,
            )
            if success:
                print(f"✓ Added position: {args.ticker.upper()} {args.shares} @ ${args.cost_basis}")
                return 0
            else:
                print(f"✗ Failed to add position")
                return 1

        elif args.position_cmd == "list":
            positions = db.get_all_positions()
            if not positions:
                print("No positions")
                return 0

            print("\n" + "=" * 60)
            print("Positions")
            print("=" * 60)
            for pos in positions:
                print(
                    f"{pos['ticker']:6} {pos['shares']:>10.0f} @ ${pos['cost_basis']:>10.2f} "
                    f"(${pos['shares'] * pos['cost_basis']:>12.2f})"
                )
            print("=" * 60)
            return 0
        else:
            print("position: add or list required")
            return 1

    except Exception as e:
        logger.error(f"Position command failed: {e}")
        return 1


def cmd_watchlist(args) -> int:
    """Watchlist management command."""
    try:
        db = Database(args.db)

        if args.watchlist_cmd == "add":
            success = db.add_watchlist(
                ticker=args.ticker.upper(),
                thesis=args.thesis,
                notes=args.notes or None,
            )
            if success:
                print(f"✓ Added to watchlist: {args.ticker.upper()}")
                return 0
            else:
                print(f"✗ Failed to add to watchlist")
                return 1

        elif args.watchlist_cmd == "list":
            watchlist = db.get_watchlist()
            if not watchlist:
                print("Watchlist is empty")
                return 0

            print("\n" + "=" * 60)
            print("Watchlist")
            print("=" * 60)
            for item in watchlist:
                print(f"{item['ticker']:6} - {item['thesis']}")
            print("=" * 60)
            return 0
        else:
            print("watchlist: add or list required")
            return 1

    except Exception as e:
        logger.error(f"Watchlist command failed: {e}")
        return 1


def cmd_scheduler(args) -> int:
    """Scheduler/cron management command."""
    from fstack.scheduler import setup_cron_interactive, list_cron_jobs

    try:
        if args.setup:
            success = setup_cron_interactive()
            return 0 if success else 1
        elif args.list:
            success = list_cron_jobs()
            return 0 if success else 1
        else:
            print("scheduler: --setup or --list required")
            return 1
    except Exception as e:
        logger.error(f"Scheduler command failed: {e}")
        return 1


def cmd_organize_reports(args) -> int:
    """Organize Morningstar PDFs from staging folder."""
    try:
        from fstack.tools.report_organizer import organize_reports

        staging_dir = Path(args.staging_dir)
        target_dir = Path(args.target_dir)
        archive_dir = Path(args.archive_dir)
        error_dir = Path(args.error_dir)

        result = asyncio.run(
            organize_reports(
                staging_dir=staging_dir,
                target_dir=target_dir,
                archive_dir=archive_dir,
                error_dir=error_dir,
                interactive=True,
            )
        )

        return 0 if not result["failed"] else 1

    except Exception as e:
        logger.error(f"Report organization failed: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
