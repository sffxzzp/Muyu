#!/usr/bin/env python3
"""Package an embedded Go executable using only the Python standard library."""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import tarfile
import time
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def check_executable(data, goos, goarch):
    if goos == 'windows':
        if data[:2] != b'MZ':
            raise ValueError('Expected a Windows executable')
        offset = struct.unpack_from('<I', data, 0x3C)[0]
        if data[offset:offset + 4] != b'PE\0\0':
            raise ValueError('Invalid PE signature')
        machine = struct.unpack_from('<H', data, offset + 4)[0]
        expected = {'amd64': 0x8664, 'arm64': 0xAA64}[goarch]
        if struct.unpack_from('<H', data, offset + 24)[0] != 0x20B:
            raise ValueError('Expected a 64-bit PE executable')
    elif goos == 'linux':
        if data[:6] != b'\x7fELF\x02\x01':
            raise ValueError('Expected a 64-bit little-endian ELF executable')
        machine = struct.unpack_from('<H', data, 18)[0]
        expected = {'amd64': 62, 'arm64': 183}[goarch]
    else:
        if data[:4] != b'\xcf\xfa\xed\xfe':
            raise ValueError('Expected a 64-bit little-endian Mach-O executable')
        machine = struct.unpack_from('<I', data, 4)[0]
        expected = {'amd64': 0x01000007, 'arm64': 0x0100000C}[goarch]
    if machine != expected:
        raise ValueError(f'Executable architecture does not match {goos}/{goarch}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--goos', choices=['linux', 'windows', 'darwin'], required=True)
    parser.add_argument('--goarch', choices=['amd64', 'arm64'], required=True)
    parser.add_argument('--version', default='dev')
    parser.add_argument('--commit', default='local')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'artifacts/releases')
    args = parser.parse_args()
    data = args.binary.read_bytes()
    check_executable(data, args.goos, args.goarch)
    assets = ROOT / 'web/dist'
    if not (assets / 'index.html').is_file():
        raise ValueError('Build or download web/dist before packaging')
    for asset in assets.rglob('*'):
        if asset.is_file() and asset.read_bytes() not in data:
            raise ValueError(f'Missing embedded asset: {asset.relative_to(assets)}')

    windows = args.goos == 'windows'
    binary_name = 'muyu.exe' if windows else 'muyu'
    platform = f'{args.goos}/{args.goarch}'
    build_info = {'version': args.version, 'commit': args.commit, 'platform': platform}
    instructions = ROOT / 'deploy' / ('windows' if windows else 'unix') / 'README.txt'
    readme = instructions.read_text(encoding='utf-8') + '\n' + (ROOT / 'deploy/README.txt').read_text(encoding='utf-8')
    readme += f'\n构建版本：{args.version}\n提交：{args.commit}\n目标平台：{platform}\n'
    entries = {
        binary_name: (data, 0o755),
        'README.txt': (readme.replace('\r\n', '\n').replace('\n', '\r\n').encode('utf-8-sig') if windows else readme.encode('utf-8'), 0o644),
        'BUILD.json': ((json.dumps(build_info, ensure_ascii=False, indent=2) + '\n').encode('utf-8'), 0o644),
        'THIRD_PARTY_NOTICES.txt': ((ROOT / 'THIRD_PARTY_NOTICES.txt').read_bytes(), 0o644),
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    name = f'muyu-{args.goos}-{args.goarch}'
    epoch = int(os.environ.get('SOURCE_DATE_EPOCH', '0'))
    if windows:
        archive = args.output_dir / f'{name}.zip'
        date = time.gmtime(max(epoch, 315532800))[:6]
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
            for filename, (contents, mode) in entries.items():
                info = zipfile.ZipInfo(f'{name}/{filename}', date_time=date)
                info.create_system = 3
                info.external_attr = (0o100000 | mode) << 16
                output.writestr(info, contents, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    else:
        archive = args.output_dir / f'{name}.tar.gz'
        with archive.open('wb') as file:
            with gzip.GzipFile(filename='', mode='wb', fileobj=file, mtime=epoch) as compressed:
                with tarfile.open(fileobj=compressed, mode='w') as output:
                    for filename, (contents, mode) in entries.items():
                        info = tarfile.TarInfo(f'{name}/{filename}')
                        info.size, info.mode, info.mtime = len(contents), mode, epoch
                        output.addfile(info, io.BytesIO(contents))
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + '.sha256').write_text(f'{checksum}  {archive.name}\n', encoding='ascii')
    print(f'{archive.name}: {len(data)} executable bytes, SHA256 {checksum}')


if __name__ == '__main__':
    main()
