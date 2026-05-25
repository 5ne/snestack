"""Cron scheduler setup helper."""

import os
import shutil
import subprocess
from pathlib import Path


def setup_cron_interactive() -> bool:
    """Guide user through setting up cron job for daily analysis.

    Returns:
        True if cron setup completed, False if cancelled
    """
    print("\n" + "=" * 60)
    print("fstack Cron Scheduler Setup")
    print("=" * 60)
    print("\nThis will add a daily cron job to run fstack batch analysis.")
    print("You'll be able to choose the time.\n")

    # Get Python path
    python_path = shutil.which("python3") or shutil.which("python")
    if not python_path:
        print("✗ Python not found in PATH")
        return False

    # Get fstack path
    try:
        result = subprocess.run(
            [python_path, "-m", "fstack", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            print("✗ fstack not found or not installed")
            return False
    except Exception as e:
        print(f"✗ Error checking fstack: {e}")
        return False

    # Get working directory
    work_dir = Path.cwd()

    # Choose time
    print("What time should analysis run? (24-hour format)")
    hour_str = input("  Hour (0-23) [6]: ").strip() or "6"
    minute_str = input("  Minute (0-59) [0]: ").strip() or "0"

    try:
        hour = int(hour_str)
        minute = int(minute_str)
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            print("✗ Invalid time")
            return False
    except ValueError:
        print("✗ Invalid time format")
        return False

    # Build cron command
    cron_cmd = f"{minute} {hour} * * * cd {work_dir} && {python_path} -m fstack batch >> logs/fstack.cron.log 2>&1"

    print(f"\n{'=' * 60}")
    print("Cron Job Preview")
    print("=" * 60)
    print(f"Time:    {hour:02d}:{minute:02d} daily")
    print(f"Command: {cron_cmd}")
    print("=" * 60)

    # Confirm
    confirm = input("\nAdd this cron job? (y/n): ").strip().lower()
    if confirm != "y":
        print("Setup cancelled.")
        return False

    # Install cron job
    try:
        # Get current crontab
        result = subprocess.run(
            ["crontab", "-l"],
            capture_output=True,
            text=True,
        )

        if result.returncode == 0:
            current_crontab = result.stdout
        else:
            current_crontab = ""

        # Add new job (with deduplication)
        if cron_cmd not in current_crontab:
            new_crontab = current_crontab + f"\n# fstack batch analysis\n{cron_cmd}\n"
        else:
            print("ℹ Cron job already installed")
            return True

        # Write new crontab
        process = subprocess.Popen(
            ["crontab", "-"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        stdout, stderr = process.communicate(input=new_crontab)

        if process.returncode != 0:
            print(f"✗ Cron install failed: {stderr}")
            return False

        print("\n✓ Cron job installed successfully!")
        print(f"\nDaily analysis will run at {hour:02d}:{minute:02d}")
        print(f"Logs saved to: {work_dir / 'logs/fstack.cron.log'}")
        print("\nTo view installed crontab:")
        print("  crontab -l")
        print("\nTo remove fstack cron job:")
        print("  crontab -e  # then delete the fstack lines")
        return True

    except FileNotFoundError:
        print("✗ crontab not found (not on Unix/Linux/macOS)")
        print("\nManual setup:")
        print("  1. Open your crontab editor:")
        print("     crontab -e")
        print("  2. Add this line:")
        print(f"     {cron_cmd}")
        print("  3. Save and exit")
        return False
    except Exception as e:
        print(f"✗ Cron setup failed: {e}")
        return False


def list_cron_jobs() -> bool:
    """List installed crontab entries.

    Returns:
        True if successful
    """
    try:
        result = subprocess.run(
            ["crontab", "-l"],
            capture_output=True,
            text=True,
        )

        if result.returncode == 0:
            print("\n" + "=" * 60)
            print("Installed Crontab")
            print("=" * 60)
            print(result.stdout)
            print("=" * 60)
            return True
        else:
            print("No crontab installed")
            return False

    except FileNotFoundError:
        print("crontab not found (not on Unix/Linux/macOS)")
        return False
    except Exception as e:
        print(f"Error listing crontab: {e}")
        return False
