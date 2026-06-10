#!/usr/bin/env python3
"""
Build a CryptoClock Pro package zip from a directory.

  python3 make_package.py <src_dir> <out.zip>

<src_dir> must contain layout.json (and optionally app.wasm, assets/, audio/).
Generates manifest.json (per-file sha256) inside the zip and prints the
outer sha256 + the MQTT sync command to push it.
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    h.update(p.read_bytes())
    return h.hexdigest()


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    src = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve()

    layout_path = src / "layout.json"
    if not layout_path.exists():
        print(f"error: {layout_path} not found")
        return 1
    layout = json.loads(layout_path.read_text())
    meta = layout.get("meta", {})
    package_id = meta.get("id", "com.ccp.unknown")
    version = meta.get("version", "0.0.0")

    files = [
        p for p in sorted(src.rglob("*"))
        if p.is_file() and p.name != "manifest.json" and not p.name.startswith(".")
    ]
    manifest = {
        "manifest_version": 1,
        "package_id": package_id,
        "version": version,
        "min_fw_version": meta.get("min_fw", "0.1.0"),
        "layout": "layout.json",
        "total_size": sum(p.stat().st_size for p in files),
        "files": [
            {
                "path": str(p.relative_to(src)),
                "sha256": sha256_file(p),
                "size": p.stat().st_size,
            }
            for p in files
        ],
    }
    wasm = [f["path"] for f in manifest["files"] if f["path"].endswith(".wasm")]
    if wasm:
        manifest["wasm_entry"] = wasm[0]

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
        for p in files:
            z.write(p, str(p.relative_to(src)))

    outer = sha256_file(out)
    print(f"package : {package_id}@{version}")
    print(f"zip     : {out} ({out.stat().st_size} bytes)")
    print(f"sha256  : {outer}")
    print("\nMQTT cmd payload (publish to ccp/v1/<device_id>/cmd):")
    print(json.dumps({
        "id": "manual-1",
        "type": "sync",
        "params": {
            "package_id": package_id,
            "version": version,
            "bundle_url": f"http://<server>/bundles/{out.name}",
            "bundle_sha256": outer,
        },
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
