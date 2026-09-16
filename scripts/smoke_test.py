#!/usr/bin/env python3
"""Verify the HTTP service and embedded website, with or without a container."""

import argparse
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


class Resources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        path = attrs.get('src') if tag == 'script' else attrs.get('href') if tag == 'link' else None
        if path and path.startswith('/') and not path.startswith('//'):
            self.paths.add(path)


def check(base, assets, timeout, process=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def fetch(path):
        with opener.open(base.rstrip('/') + path, timeout=3) as response:
            if response.status != 200:
                raise RuntimeError(f'{path}: HTTP {response.status}')
            return response.read(), response.headers.get_content_type()

    deadline = time.monotonic() + timeout
    while True:
        try:
            health, _ = fetch('/api/health')
            if json.loads(health).get('status') != 'ok':
                raise RuntimeError('Unexpected health response')
            break
        except (OSError, urllib.error.URLError):
            if process is not None and process.poll() is not None:
                raise RuntimeError('Server exited before becoming ready') from None
            if time.monotonic() >= deadline:
                raise RuntimeError('Timed out waiting for the health endpoint') from None
            time.sleep(0.1)

    html, content_type = fetch('/')
    if content_type != 'text/html' or b'<html' not in html:
        raise RuntimeError('The root URL did not return the website')
    resources = Resources()
    resources.feed(html.decode('utf-8'))
    if not resources.paths:
        raise RuntimeError('No website assets were found in index.html')
    for path in sorted(resources.paths):
        content, content_type = fetch(path)
        if not content or content_type == 'text/html':
            raise RuntimeError(f'Asset {path} is missing or returned the SPA fallback')
    fallback, _ = fetch('/task/smoke-test')
    if fallback != html:
        raise RuntimeError('SPA fallback did not return index.html')
    if assets is not None:
        if html != (assets / 'index.html').read_bytes():
            raise RuntimeError('Embedded index.html does not match the frontend build')
        for asset in assets.rglob('*'):
            if asset.is_file():
                path = '/' + urllib.parse.quote(asset.relative_to(assets).as_posix())
                content, _ = fetch(path)
                if content != asset.read_bytes():
                    raise RuntimeError(f'Embedded content differs for {path}')
    print(f'HTTP smoke check passed: health, website, {len(resources.paths)} linked assets, SPA fallback')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--binary', type=Path)
    target.add_argument('--url')
    parser.add_argument('--assets', type=Path)
    parser.add_argument('--timeout', type=float, default=30)
    args = parser.parse_args()
    if args.url:
        check(args.url, args.assets, args.timeout)
        return
    with tempfile.TemporaryDirectory(prefix='muyu-smoke-') as directory:
        binary = Path(directory) / args.binary.name
        shutil.copy2(args.binary.resolve(), binary)
        binary.chmod(0o755)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        env = os.environ.copy()
        env.pop('ADDR', None)
        env.update(LISTEN_HOST='127.0.0.1', LISTEN_PORT=str(port))
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen([str(binary)], cwd=directory, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                check(f'http://127.0.0.1:{port}', args.assets, args.timeout, process)
                if sorted(file.name for file in Path(directory).iterdir()) != [binary.name]:
                    raise RuntimeError('Standalone startup created unexpected files')
            except Exception:
                log.seek(0)
                print(log.read().decode('utf-8', errors='replace'))
                raise
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == '__main__':
    main()
