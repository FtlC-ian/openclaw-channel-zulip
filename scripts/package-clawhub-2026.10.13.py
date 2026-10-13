#!/usr/bin/env python3
"""Create the authorized ClawHub-only derivative of the frozen npm release."""

import gzip
import hashlib
import io
import json
import pathlib
import sys
import tarfile

SOURCE_SHA256 = "aec3da32e020864640cb30bf1a8fa7dcb4922ac4e8a91657b27b3db38e59864b"
SOURCE_COMMIT = "26a717007c5e2c9e20bca488fecbc69c6fe77fd7"
CATALOG_NAME = "@ftlc-ian/openclaw-channel-zulip"


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: package-clawhub-2026.10.13.py INPUT.tgz OUTPUT.tgz")
    source, destination = map(pathlib.Path, sys.argv[1:])
    source_bytes = source.read_bytes()
    if hashlib.sha256(source_bytes).hexdigest() != SOURCE_SHA256:
        raise SystemExit("Input does not match the verified npm 2026.10.13 artifact")
    with tarfile.open(fileobj=io.BytesIO(source_bytes), mode="r:gz") as archive:
        members = archive.getmembers()
        if any(not member.isfile() for member in members):
            raise SystemExit("Expected only regular files in the frozen artifact")
        files = {member.name: archive.extractfile(member).read() for member in members}
        modes = {member.name: member.mode for member in members}
    package = json.loads(files["package/package.json"])
    if (package["name"], package["version"]) != ("openclaw-channel-zulip", "2026.10.13"):
        raise SystemExit("Unexpected source package identity")
    if package["devDependencies"]["openclaw"] != "2026.9.6":
        raise SystemExit("Unexpected source build SDK")
    package["name"] = CATALOG_NAME
    package["openclaw"]["channel"]["configuredState"] = {
        "env": {"allOf": ["ZULIP_API_KEY", "ZULIP_EMAIL"], "anyOf": ["ZULIP_URL", "ZULIP_SITE", "ZULIP_REALM"]}
    }
    package["openclaw"]["compat"] = {"pluginApi": ">=2026.9.3"}
    package["openclaw"]["build"] = {"openclawVersion": "2026.9.6"}
    files["package/package.json"] = (json.dumps(package, indent=2, ensure_ascii=False) + "\n").encode()
    tar_bytes = io.BytesIO()
    manifest = json.loads(files["package/openclaw.plugin.json"])
    manifest["name"] = "Zulip"
    manifest.pop("channelEnvVars", None)
    files["package/openclaw.plugin.json"] = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode()
    with tarfile.open(fileobj=tar_bytes, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name in sorted(files):
            member = tarfile.TarInfo(name)
            member.mode = modes[name]
            member.size = len(files[name])
            member.mtime = member.uid = member.gid = 0
            archive.addfile(member, io.BytesIO(files[name]))
    result = io.BytesIO()
    with gzip.GzipFile(fileobj=result, mode="wb", filename="", mtime=0, compresslevel=9) as archive:
        archive.write(tar_bytes.getvalue())
    artifact = result.getvalue()
    with destination.open("xb") as output:
        output.write(artifact)
    print(json.dumps({
        "sourceCommit": SOURCE_COMMIT, "sourceSha256": SOURCE_SHA256,
        "name": CATALOG_NAME, "version": package["version"],
        "sha256": hashlib.sha256(artifact).hexdigest(),
        "npmShasum": hashlib.sha1(artifact).hexdigest(),
        "bytes": len(artifact), "files": len(files),
        "changedFiles": ["package/package.json", "package/openclaw.plugin.json"],
    }, indent=2))


if __name__ == "__main__":
    main()
