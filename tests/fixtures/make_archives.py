#!/usr/bin/env python3
"""生成测试用归档与对应清单。产物在 tests/fixtures/generated/。

用 python3 的 tarfile/zipfile 而不是 shell 的 tar/zip：路径穿越条目在 bsdtar 与 GNU tar
上行为不一致（`--transform` vs `-s`），而这里需要精确控制归档内的条目名。

用法：
    python3 -I tests/fixtures/make_archives.py

生成：
    evil.tar.gz        条目名为 ../../evil.txt（TC-RT-005 路径穿越）
    evil-abs.tar.gz    条目名为绝对路径（TC-RT-006）
    evil.zip           条目名为 ../evil.txt（TC-RT-008 zip 通道）
    fake-ok.tar.gz     假 sing-box：响应 version、check，run 时挂起（TC-RT-009 替身）
    fake-crash.tar.gz  假 sing-box：run 立即退出（TC-EXC-021 崩溃重启）

并写回 manifest-traversal.json / manifest-fake-ok.json / manifest-fake-crash.json，
sha256 与 size 按实际产物计算。
"""

import io
import json
import os
import shutil
import tarfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "generated")
MOCK_PORT = os.environ.get("MOCK_CATALOG_PORT", "18090")

FAKE_OK = """#!/bin/sh
case "$1" in
  version) echo "sing-box version 1.14.4"; exit 0 ;;
  check)   exit 0 ;;
  run)     sleep 3600; exit 0 ;;
esac
exit 0
"""

FAKE_CRASH = """#!/bin/sh
case "$1" in
  version) echo "sing-box version 1.14.4"; exit 0 ;;
  check)   exit 0 ;;
  run)     echo "FATAL mock crash" >&2; exit 1 ;;
esac
exit 0
"""


def add_bytes(tar, name, data, mode=0o644):
    info = tarfile.TarInfo(name=name)
    info.size = len(data)
    info.mode = mode
    tar.addfile(info, io.BytesIO(data))


def make_tar(path, entries):
    with tarfile.open(path, "w:gz") as tar:
        for name, data, mode in entries:
            add_bytes(tar, name, data, mode)


def make_zip(path, entries):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data, _mode in entries:
            zf.writestr(name, data)


def sha_of(path):
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_manifest(filename, asset, version="1.14.4"):
    path = os.path.join(OUT, asset)
    manifest = {
        "schema": 1,
        "releases": [
            {
                "upstream_version": version,
                "platform": "darwin",
                "arch": "arm64",
                "url": f"http://127.0.0.1:{MOCK_PORT}/__file?name={asset}",
                "sha256": sha_of(path),
                "size": os.path.getsize(path),
                "source_url": "local",
                "license": "GPL-3.0-or-later",
            }
        ],
    }
    with open(os.path.join(HERE, filename), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  {filename:28s} -> {asset} sha256={sha_of(path)[:16]}… size={os.path.getsize(path)}")


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT, exist_ok=True)

    payload = b"pwned\n"

    make_tar(os.path.join(OUT, "evil.tar.gz"), [("../../evil.txt", payload, 0o644)])
    make_tar(
        os.path.join(OUT, "evil-abs.tar.gz"),
        [(os.path.join(OUT, "abs", "evil.txt"), payload, 0o644)],
    )
    make_zip(os.path.join(OUT, "evil.zip"), [("../evil.txt", payload, 0o644)])

    fake = [
        ("sing-box", FAKE_OK.encode(), 0o755),
        ("LICENSE", b"fake license\n", 0o644),
    ]
    make_tar(os.path.join(OUT, "fake-ok.tar.gz"), fake)

    crash = [
        ("sing-box", FAKE_CRASH.encode(), 0o755),
        ("LICENSE", b"fake license\n", 0o644),
    ]
    make_tar(os.path.join(OUT, "fake-crash.tar.gz"), crash)

    print(f"[make_archives] 产物目录：{OUT}")
    write_manifest("manifest-traversal.json", "evil.tar.gz")
    write_manifest("manifest-fake-ok.json", "fake-ok.tar.gz")
    write_manifest("manifest-fake-crash.json", "fake-crash.tar.gz")
    print("[make_archives] 清单已写入 tests/fixtures/manifest-*.json")


if __name__ == "__main__":
    main()
