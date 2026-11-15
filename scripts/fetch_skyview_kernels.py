#!/usr/bin/env python3
"""Explicit one-time NAIF download. The API never downloads or substitutes data.

Usage: python scripts/fetch_skyview_kernels.py --directory /path/to/kernels
"""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

BASE = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"
SOURCES = {
    "naif0012.tls": "lsk/naif0012.tls",
    "de421.bsp": "spk/planets/a_old_versions/de421.bsp",
    "moon_pa_de421_1900-2050.bpc": "pck/moon_pa_de421_1900-2050.bpc",
    "moon_080317.tf": "fk/satellites/moon_080317.tf",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    records = []
    for name, remote in SOURCES.items():
        target = args.directory / name
        if target.exists():
            raise SystemExit(f"Refusing to overwrite {target}; use an empty directory")
        temporary = target.with_suffix(target.suffix + ".part")
        digest = hashlib.sha256()
        try:
            with urlopen(BASE + remote, timeout=120) as source, temporary.open("xb") as output:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    output.write(block)
                    digest.update(block)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
        records.append({"file": name, "url": BASE + remote, "sha256": digest.hexdigest(), "bytes": target.stat().st_size})
        print(f"Downloaded {name}: {target.stat().st_size} bytes")
    (args.directory / "sources.json").write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
