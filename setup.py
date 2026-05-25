"""fstack package installation configuration."""

from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as f:
    long_description = f.read()

setup(
    name="fstack",
    version="0.1.0",
    description="Personal investment decision-support system powered by Claude",
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="Your Name",
    author_email="your.email@example.com",
    url="https://github.com/yourusername/fstack",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "pydantic>=2.0,<3.0",
        "python-dotenv>=1.0,<2.0",
        "anthropic>=0.25,<1.0",
        "finnhub-python>=1.2,<2.0",
        "requests>=2.31,<3.0",
        "google-auth-oauthlib>=1.0,<2.0",
        "google-auth-httplib2>=0.2,<1.0",
        "google-api-python-client>=2.100,<3.0",
        "twilio>=8.0,<9.0",
    ],
    extras_require={
        "dev": [
            "pytest>=7.0,<8.0",
            "pytest-asyncio>=0.21,<1.0",
            "pytest-cov>=4.0,<5.0",
            "black>=23.0,<24.0",
            "ruff>=0.1,<1.0",
            "mypy>=1.0,<2.0",
        ],
    },
    entry_points={
        "console_scripts": [
            "fstack=fstack.cli:main",
        ],
    },
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Financial and Insurance Industry",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
    ],
)
