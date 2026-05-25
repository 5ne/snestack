"""Allow running fstack as: python -m fstack"""

from fstack.cli import main
import sys

if __name__ == "__main__":
    sys.exit(main())
