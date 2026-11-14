"""Materialize a pinned image's tracked source without running repository code.

Only the task layer's Git objects are read. No Docker daemon, checkout hooks,
project filters, build/install commands, test code, or Git history enter review.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile
import zlib


def materialize(layer, project, head, base, source_repo=None, base_cache=None):
    project = Path(project).resolve()
    if project.exists():
        raise ValueError('Source destination must be new')
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
               GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0')
    with tempfile.TemporaryDirectory(prefix='forge-review-git-') as temporary:
        repository = Path(temporary) / 'git'
        repository.mkdir()
        object_backing = None
        if source_repo:
            import re
            if not re.fullmatch(r'[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+', source_repo):
                raise ValueError('Unsupported public source repository')
            object_backing = Path(base_cache).resolve()
            subprocess.run(['git', '-c', 'core.hooksPath=', 'init', '--bare', str(object_backing)],
                           env=env, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            fetch_command = ['git', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
                             '--git-dir', str(object_backing)]
            present = subprocess.run(fetch_command + ['cat-file', '-e', base + '^{commit}'],
                                     env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            if present.returncode:
                subprocess.run(fetch_command + ['fetch', '--depth=1', '--no-tags',
                               'https://github.com/' + source_repo + '.git', base],
                               env=env, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
            subprocess.run(['git', '-c', 'core.hooksPath=', 'init', '--bare', str(repository)],
                           env=env, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            (repository / 'objects' / 'info' / 'alternates').write_bytes(((object_backing / 'objects').as_posix() + '\n').encode('utf-8'))
            if (object_backing / 'shallow').exists():
                (repository / 'shallow').write_bytes((object_backing / 'shallow').read_bytes())
        with tarfile.open(layer, 'r:gz') as archive:
            for member in archive:
                if source_repo and member.name.startswith('testbed/.git/objects/pack'):
                    # Complete loose objects precede the huge historical pack.
                    # Their SHA-1 IDs and the recorded final tree verify contents.
                    break
                if not member.name.startswith('testbed/.git/'):
                    continue
                path = PurePosixPath(member.name[len('testbed/.git/'):])
                if path.is_absolute() or '..' in path.parts or any(':' in p or '\\' in p for p in path.parts):
                    raise ValueError('Unsafe Git metadata path in task layer')
                if member.isdir():
                    continue
                if not member.isfile() or member.size > 500_000_000:
                    raise ValueError('Unsupported Git metadata member')
                # Hooks/config are not needed to read objects. Do not materialize them.
                if path.parts[0] in ('hooks', 'config', 'config.worktree'):
                    continue
                if source_repo and path.parts[:2] == ('objects', 'info'):
                    continue
                target = repository.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('wb') as destination:
                    while chunk := source.read(1024 * 1024):
                        destination.write(chunk)
                if path.parts[0] == 'objects' and len(path.parts) == 3 and len(path.parts[1]) == 2:
                    if hashlib.sha1(zlib.decompress(target.read_bytes())).hexdigest() != path.parts[1] + path.parts[2]:
                        raise ValueError('Image loose object fingerprint mismatch')

        command = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'core.commitGraph=false',
                   '--git-dir', str(repository)]

        def git(*arguments):
            result = subprocess.run(command + list(arguments), env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            if result.returncode:
                raise ValueError('Reading fixed Git objects failed: ' + result.stderr.decode(errors='replace'))
            return result.stdout

        actual = git('rev-parse', (head if source_repo else 'HEAD') + '^{commit}').decode().strip()
        if actual != head:
            raise ValueError('Task layer HEAD does not match the retained execution')
        git('merge-base', '--is-ancestor', base, head)
        tree = git('rev-parse', head + '^{tree}').decode().strip()
        entries = git('ls-tree', '-rz', '--full-tree', head).split(b'\0')
        project.mkdir(parents=True)
        clean_command = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', str(project)]

        def clean_git(*arguments, data=None):
            return subprocess.run(clean_command + list(arguments), input=data, env=env, check=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60).stdout

        clean_git('init', '-q', '-b', 'replay')
        clean_git('config', 'core.autocrlf', 'false')
        clean_git('config', 'core.filemode', 'false')
        clean_git('config', 'core.symlinks', 'false')
        index = []
        files = []
        with subprocess.Popen(command + ['cat-file', '--batch'], env=env,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as reader:
            try:
                for entry in filter(None, entries):
                    metadata, raw_path = entry.split(b'\t', 1)
                    mode, kind, oid = metadata.decode().split()
                    path = PurePosixPath(raw_path.decode())
                    if path.is_absolute() or '..' in path.parts or any(':' in p or '\\' in p for p in path.parts):
                        raise ValueError('Unsafe tracked source path')
                    if kind == 'commit' and mode == '160000':
                        project.joinpath(*path.parts).mkdir(parents=True, exist_ok=True)
                        index.append(mode.encode() + b' ' + oid.encode() + b'\t' + raw_path + b'\0')
                        files.append({'path': str(path), 'mode': mode, 'commit': oid, 'materialized': False})
                        continue
                    if kind != 'blob' or mode not in ('100644', '100755', '120000'):
                        # Git's Windows representation keeps symlink target bytes and mode.
                        # Submodules are not silently substituted.
                        raise ValueError('Unsupported source entry: ' + mode + ' ' + str(path))
                    reader.stdin.write(oid.encode() + b'\n')
                    reader.stdin.flush()
                    header = reader.stdout.readline().decode().strip().split()
                    if len(header) != 3 or header[:2] != [oid, 'blob']:
                        raise ValueError('Task-layer Git object is missing')
                    size = int(header[2])
                    if size > 100_000_000:
                        raise ValueError('Tracked source object exceeds limit')
                    data = reader.stdout.read(size)
                    if reader.stdout.read(1) != b'\n' or len(data) != size:
                        raise ValueError('Incomplete Git object')
                    digest = hashlib.sha1(b'blob ' + str(size).encode() + b'\0' + data).hexdigest()
                    if digest != oid:
                        raise ValueError('Git source object fingerprint mismatch')
                    target = project.joinpath(*path.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    blob = project / '.git' / 'objects' / oid[:2] / oid[2:]
                    if not blob.exists():
                        blob.parent.mkdir(parents=True, exist_ok=True)
                        blob.write_bytes(zlib.compress(b'blob ' + str(size).encode() + b'\0' + data))
                    index.append(mode.encode() + b' ' + oid.encode() + b'\t' + raw_path + b'\0')
                    files.append({'path': str(path), 'mode': mode, 'blob': oid, 'bytes': size})
            finally:
                reader.stdin.close()
                if reader.wait(timeout=30) != 0:
                    raise ValueError('Reading Git objects failed')
        clean_git('update-index', '-z', '--index-info', data=b''.join(index))
        if clean_git('write-tree').decode().strip() != tree:
            raise ValueError('Materialized Git tree differs from the original image tree')
        env.update(GIT_AUTHOR_NAME='Forge Replay', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                   GIT_COMMITTER_NAME='Forge Replay', GIT_COMMITTER_EMAIL='fixture@example.invalid',
                   GIT_AUTHOR_DATE='2026-11-14T00:00:00Z', GIT_COMMITTER_DATE='2026-11-14T00:00:00Z')
        commit = clean_git('commit-tree', tree, '-m', 'Frozen source snapshot; no upstream history').decode().strip()
        clean_git('update-ref', 'refs/heads/replay', commit)
        if clean_git('status', '--porcelain', '--untracked-files=all').strip():
            raise ValueError('Materialized source is not a clean snapshot')
        return {'head': actual, 'baseCommit': base, 'tree': tree, 'files': files,
                'snapshotCommit': commit, 'historyExcluded': True, 'repositoryCodeExecuted': False,
                'symlinkPlaceholders': [item['path'] for item in files if item['mode'] == '120000'],
                'uninitializedSubmodules': [item['path'] for item in files if item['mode'] == '160000']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--layer', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--head', required=True)
    parser.add_argument('--base', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--source-repo')
    parser.add_argument('--base-cache')
    options = parser.parse_args()
    result = materialize(options.layer, options.project, options.head, options.base,
                         options.source_repo, options.base_cache)
    Path(options.output).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'head': result['head'], 'tree': result['tree'], 'files': len(result['files'])}))
