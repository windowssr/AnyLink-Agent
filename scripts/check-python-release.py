"""Validate Python release identity and the two distributions before publishing."""
from __future__ import annotations

import argparse
import ast
import email
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SDK = ROOT / "sdk-python"


def require(ok: bool, message: str) -> None:
    if not ok:
        raise SystemExit(message)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path)
    args = parser.parse_args()
    project = tomllib.loads((SDK / "pyproject.toml").read_text())["project"]
    require(project["name"] == "anylink-agent", "Unexpected Python project name")
    version = project["version"]
    module = ast.parse((SDK / "src/anylink/__init__.py").read_text())
    versions = [ast.literal_eval(node.value) for node in module.body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets)]
    require(versions == [version], "anylink.__version__ must match pyproject.toml")
    lock = tomllib.loads((SDK / "uv.lock").read_text())
    locked = [item["version"] for item in lock["package"] if item["name"] == project["name"] and item.get("source", {}).get("editable") == "."]
    require(locked == [version], "Update the local SDK version in uv.lock")
    tag = f"python-v{version}"
    if os.environ.get("GITHUB_REF_TYPE") == "tag":
        require(os.environ.get("GITHUB_REF_NAME") == tag, f"SDK release tag must be {tag}")
    result: dict = {"project": project["name"], "version": version, "expected_tag": tag}

    if args.dist:
        prefix = f"anylink_agent-{version}"
        names = {f"{prefix}-py3-none-any.whl", f"{prefix}.tar.gz"}
        files = [item for item in args.dist.iterdir() if not item.name.startswith(".")]
        require({item.name for item in files} == names, "Distribution folder must contain only this version's wheel and source archive")
        wheel = args.dist / f"{prefix}-py3-none-any.whl"
        source = args.dist / f"{prefix}.tar.gz"
        info = f"{prefix}.dist-info/"
        with zipfile.ZipFile(wheel) as archive:
            members = archive.namelist()
            require(all(not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts and "\\" not in name
                        and name.startswith(("anylink/", info)) for name in members), "Unexpected file in wheel")
            metadata = email.message_from_bytes(archive.read(info + "METADATA"))
            require(metadata["Name"] == project["name"] and metadata["Version"] == version, "Wheel metadata does not match the SDK")
            require(metadata["License-Expression"] == project["license"], "Wheel license metadata does not match")
            require(archive.read(info + "licenses/LICENSE") == (SDK / "LICENSE").read_bytes(), "Wheel must include the SDK license")
            for file in (SDK / "src/anylink").glob("*.py"):
                require(archive.read("anylink/" + file.name) == file.read_bytes(), "Wheel source differs from checkout")
        with tarfile.open(source) as archive:
            members = archive.getmembers()
            require(all(not item.issym() and not item.islnk() and item.name.startswith(prefix + "/")
                        and ".." not in PurePosixPath(item.name).parts and "\\" not in item.name
                        and not {"secrets", "data", "artifacts", "examples", ".venv"}.intersection(PurePosixPath(item.name).parts)
                        for item in members), "Unexpected file in source archive")
            require(f"{prefix}/LICENSE" in archive.getnames(), "Source archive must include the SDK license")
        result["files"] = [{"name": item.name, "bytes": item.stat().st_size, "sha256": hashlib.sha256(item.read_bytes()).hexdigest()} for item in sorted(files)]
    print(json.dumps(result))


if __name__ == "__main__":
    main()
