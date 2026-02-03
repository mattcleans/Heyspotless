"""
Setup script for Hey Spotless Automation
"""

from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

setup(
    name="heyspotless-automation",
    version="1.0.0",
    author="Matt",
    author_email="matt@heyspotless.com",
    description="Automated email monitoring and appointment booking for Hey Spotless",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/mattcleans/Heyspotless",
    packages=find_packages(),
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: End Users/Desktop",
        "Topic :: Office/Business :: Scheduling",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
    ],
    python_requires=">=3.8",
    install_requires=[
        "anthropic>=0.18.0",
        "google-auth>=2.27.0",
        "google-auth-oauthlib>=1.2.0",
        "google-auth-httplib2>=0.2.0",
        "google-api-python-client>=2.116.0",
        "email-validator>=2.1.0",
        "python-dotenv>=1.0.0",
        "schedule>=1.2.0",
        "python-dateutil>=2.8.2",
        "twilio>=8.13.0",
        "requests>=2.31.0",
        "pytz>=2024.1",
        "pyyaml>=6.0.1",
    ],
    entry_points={
        "console_scripts": [
            "heyspotless=main:main",
        ],
    },
)
