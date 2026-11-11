"""Private controller for pinned SWE-bench. Never copied into an agent container."""
from __future__ import annotations
import hashlib
import importlib.metadata
import io
import json
import os
import platform
import signal
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path
from unittest.mock import patch as mock_patch

HARNESS_COMMIT = '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e'
PROTOCOL = 'forge-swebench-lite-official-v2'
ACTIVE = []

def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)

def harness_identity():
    dist = importlib.metadata.distribution('swebench')
    direct = json.loads(dist.read_text('direct_url.json') or '{}')
    if direct.get('vcs_info', {}).get('commit_id') != HARNESS_COMMIT:
        raise RuntimeError('Install the exact harness commit from evals/swebench-lite/harness-requirements.txt')
    import swebench
    root = Path(swebench.__file__).parent
    digest = hashlib.sha256()
    for file in sorted(root.rglob('*.py')):
        digest.update(str(file.relative_to(root)).encode())
        digest.update(file.read_bytes())
    return {'commit': HARNESS_COMMIT, 'version': dist.version, 'sourceHash': digest.hexdigest()}

def doctor():
    result = {'protocol': PROTOCOL, 'system': platform.system(), 'machine': platform.machine(), 'python': platform.python_version(), 'ready': False, 'errors': []}
    if platform.system() != 'Linux':
        result['errors'].append('Run on Linux or inside a WSL2 Linux distribution; Windows Python is not the evaluation host.')
    if platform.machine().lower() not in ('x86_64', 'amd64'):
        result['errors'].append('This protocol fixes linux/amd64 images; ARM needs a separately declared emulation protocol.')
    try:
        result['harness'] = harness_identity()
    except Exception as error:
        result['errors'].append(str(error))
    try:
        import docker
        client = docker.from_env(timeout=20)
        info = client.info()
        result['docker'] = {'server': client.version()['Version'], 'os': info.get('OSType'), 'architecture': info.get('Architecture')}
        if info.get('OSType') != 'linux':
            result['errors'].append('Docker must run Linux containers')
        client.close()
    except Exception as error:
        result['errors'].append('Docker unavailable: ' + str(error))
    result['ready'] = not result['errors']
    return result

def put_bytes(container, target, data, mode=0o600):
    destination = Path(target)
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode='w') as tar:
        entry = tarfile.TarInfo(destination.name)
        entry.size, entry.mode = len(data), mode
        tar.addfile(entry, io.BytesIO(data))
    container.put_archive(str(destination.parent), archive.getvalue())

def take_bytes(container, path, limit=16000000):
    stream, _ = container.get_archive(path)
    chunks, size = [], 0
    for chunk in stream:
        size += len(chunk)
        if size > limit:
            raise RuntimeError('Container artifact exceeds bound: ' + path)
        chunks.append(chunk)
    with tarfile.open(fileobj=io.BytesIO(b''.join(chunks))) as archive:
        member = archive.next()
        if not member or not member.isfile() or member.size > limit:
            raise RuntimeError('Container artifact is not a bounded regular file')
        return archive.extractfile(member).read()

def expected_present(record, status_map):
    from swebench.harness.grading import _resolve_case
    return all(_resolve_case(case, status_map) is not None for case in record['FAIL_TO_PASS'] + record['PASS_TO_PASS'])

def official_grade(client, record, image_id, model_patch, output, timeout, baseline=False):
    """Use official execution/patching/parsing/grading; only container privileges differ."""
    from swebench.harness import run_evaluation as official
    from swebench.harness.utils import make_test_spec
    from swebench.harness.grading import get_logs_eval
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    run_id = 'forge-' + uuid.uuid4().hex
    grading_record = {**record, 'image': image_id}
    spec = make_test_spec(grading_record)
    prediction = {'instance_id': record['instance_id'], 'model_name_or_path': 'forge-evaluation', 'model_patch': model_patch}
    def create_restricted(spec, docker_client, run_id, logger):
        # Python Lite tasks need no SYS_ADMIN, privileged mode, host mounts or sockets.
        container = docker_client.containers.create(image=spec.image, command=['tail', '-f', '/dev/null'], detach=True,
            labels={'forge.swebench.run': run_id}, cap_drop=['ALL'], security_opt=['no-new-privileges'])
        ACTIVE.append(container)
        return container
    previous = Path.cwd()
    try:
        os.chdir(output)
        with mock_patch.object(official, 'create_container', create_restricted), mock_patch.object(official, 'RUN_EVALUATION_LOG_DIR', output / 'logs' / 'evaluation'):
            answer = official.run_instance(spec, prediction, client, run_id, timeout=timeout, skip_patch=baseline)
        logs = list(output.glob('logs/evaluation/*/forge-evaluation/*'))
        if len(logs) != 1:
            return {'valid': False, 'resolved': None, 'reason': 'official_report_missing'}
        log_dir = logs[0]
        if not answer:
            run_log = (log_dir / 'run_instance.log').read_text(errors='replace') if (log_dir / 'run_instance.log').exists() else ''
            return {'valid': False, 'resolved': None, 'patchRejected': official.APPLY_PATCH_FAIL in run_log, 'reason': 'official_execution_failed', 'diagnostic': run_log[-12000:]}
        summary = answer[1][record['instance_id']]
        test_log = log_dir / 'test_output.txt'
        if not test_log.exists():
            return {'valid': False, 'resolved': None, 'reason': 'test_output_missing'}
        status_map, found = get_logs_eval(spec, str(test_log))
        complete = found and expected_present(record, status_map) and not summary.get('infra_failure', False)
        tests = summary.get('tests_status', {})
        from swebench.harness.grading import _resolve_case
        actual_failures = all(status_map.get(_resolve_case(case, status_map)) in ('FAILED', 'ERROR') for case in record['FAIL_TO_PASS'])
        baseline_ok = bool(complete and actual_failures and not summary.get('resolved')
            and len(tests.get('FAIL_TO_PASS', {}).get('failure', [])) == len(record['FAIL_TO_PASS'])
            and not tests.get('PASS_TO_PASS', {}).get('failure', []))
        result = {'valid': bool(complete), 'resolved': bool(summary['resolved']) if complete else None,
            'baselineExpectedFailure': baseline_ok, 'tests': tests, 'officialReport': str((log_dir / 'report.json').relative_to(output)),
            'reason': None if complete else 'incomplete_test_evidence',
            **({'diagnostic': test_log.read_text(errors='replace')[-12000:]} if not complete else {})}
        save(output / 'assessment.json', result)
        return result
    finally:
        os.chdir(previous)
        for container in ACTIVE[:]:
            try:
                container.remove(force=True)
            except Exception:
                pass
            ACTIVE.remove(container)

def validation(request, client, identity):
    bundle, out = Path(request['bundle']), Path(request['output'])
    manifest = json.loads((bundle / 'manifest.json').read_text())
    report = {'protocol': PROTOCOL, 'cohortFingerprint': manifest['fingerprint'], 'harnessCommit': HARNESS_COMMIT,
        'backendHash': request['backendHash'], 'harness': identity, 'containerPolicy': 'fresh-linux-amd64-no-host-mounts-no-sys-admin',
        'total': len(manifest['tasks']), 'valid': 0, 'results': []}
    for task in manifest['tasks']:
        key = task['instanceId']
        record = json.loads((bundle / 'records' / (key + '.json')).read_text())
        row = {'instanceId': key, 'valid': False}
        try:
            try:
                image = client.images.get(record['image'])
            except Exception:
                image = client.images.pull(record['image'], platform='linux/amd64')
            if image.attrs.get('Architecture') != 'amd64':
                raise RuntimeError('Task image must be linux/amd64')
            row['imageId'], row['repoDigests'] = image.id, image.attrs.get('RepoDigests', [])
            for repetition in range(request.get('repeat', 1)):
                stamp = uuid.uuid4().hex[:8]
                baseline = official_grade(client, record, image.id, '', out / key / ('baseline-' + stamp), request['timeout'], True)
                reference = official_grade(client, record, image.id, record['patch'], out / key / ('gold-' + stamp), request['timeout'])
                row.setdefault('runs', []).append({'baseline': baseline, 'reference': reference})
            row['baseline'] = row['runs'][-1]['baseline']
            row['reference'] = row['runs'][-1]['reference']
            row['valid'] = all(run['baseline'].get('baselineExpectedFailure') and run['reference']['valid'] and run['reference']['resolved'] for run in row['runs'])
        except Exception as error:
            row['error'] = str(error)
        report['results'].append(row)
        report['valid'] = sum(item['valid'] for item in report['results'])
        save(out / 'cohort-validation.json', report)
        print(('VALID ' if row['valid'] else 'INVALID ') + key, flush=True)
    save(out / 'cohort-validation.json', report)
    return report

def runner_image(client, request, task_image_ref):
    package = Path(request['package'])
    if hashlib.sha256(package.read_bytes()).hexdigest() != request['packageHash']:
        raise RuntimeError('Forge package fingerprint changed')
    node_image = client.images.get(request['nodeImageId'])
    if node_image.id != request['nodeImageId']:
        raise RuntimeError('Node image identity mismatch')
    task_image = client.images.get(task_image_ref)
    if task_image.id != request['imageId']:
        raise RuntimeError('Task image identity mismatch')
    digest = hashlib.sha256((task_image.id + request['packageHash'] + request['agentHash'] + node_image.id).encode()).hexdigest()
    tag = 'forge-swebench-runner:' + digest[:32]
    try:
        return client.images.get(tag)
    except Exception:
        pass
    with tempfile.TemporaryDirectory(prefix='forge-runner-build-') as directory:
        root = Path(directory)
        (root / 'forge.tgz').write_bytes(package.read_bytes())
        agent_bytes = Path(request['agentScript']).read_bytes()
        if hashlib.sha256(agent_bytes).hexdigest() != request['agentHash']:
            raise RuntimeError('Agent runner fingerprint changed')
        (root / 'agent.mjs').write_bytes(agent_bytes)
        (root / 'Dockerfile').write_text('FROM ' + request['nodeImageRef'] + ' AS forge_node\nFROM ' + task_image_ref + '\n'
            'COPY --from=forge_node /usr/local/bin/node /usr/local/bin/node\n'
            'COPY --from=forge_node /usr/local/lib/node_modules/npm /opt/forge-npm\n'
            'COPY forge.tgz /tmp/forge.tgz\n'
            'RUN node /opt/forge-npm/bin/npm-cli.js install --prefix /opt/forge --omit=dev --no-audit --no-fund /tmp/forge.tgz && rm /tmp/forge.tgz\n'
            'COPY agent.mjs /opt/forge/agent.mjs\n', encoding='utf-8')
        image, logs = client.images.build(path=str(root), tag=tag, rm=True, forcerm=True, timeout=1800)
        return image

def agent_run(request, client):
    image = runner_image(client, request, request['imageRef'])
    container = client.containers.create(image=image.id, command=['tail', '-f', '/dev/null'], detach=True,
        labels={'forge.swebench.run': request['executionId']}, cap_drop=['ALL'], security_opt=['no-new-privileges'],
        **({'extra_hosts': {'host.docker.internal': 'host-gateway'}} if request.get('fixtureModelHostGateway') is True else {}))
    ACTIVE.append(container)
    output = Path(request['output'])
    output.mkdir(parents=True, exist_ok=True)
    try:
        container.start()
        check = container.exec_run(['git', 'rev-parse', 'HEAD'], workdir='/testbed')
        expected_head = request.get('environmentSetupCommit') or request['baseCommit']
        if check.exit_code or check.output.decode().strip() != expected_head:
            actual_head = check.output.decode(errors='replace').strip()
            raise RuntimeError('Task image checkout mismatch: actual_head=' + actual_head + '; expected_environment_setup_commit=' + str(request.get('environmentSetupCommit')) + '; expected_base_commit=' + str(request.get('baseCommit')))
        clean = container.exec_run(['git', 'diff', '--exit-code', 'HEAD'], workdir='/testbed')
        if clean.exit_code:
            raise RuntimeError('Task image has pre-existing tracked modifications')
        container.exec_run(['mkdir', '-p', '/tmp/forge-home', '/tmp/forge-output'])
        # Only model configuration and the public problem statement enter the worker.
        for name in ('models.json', 'auth.json'):
            path = Path(request['configHome']) / name
            if path.exists():
                put_bytes(container, '/tmp/forge-home/' + name, path.read_bytes())
        public = {key: request[key] for key in ('instanceId', 'baseCommit', 'prompt', 'model', 'workflow', 'thinking', 'limits', 'visibleCommand')}
        put_bytes(container, '/tmp/forge-input.json', json.dumps(public).encode())
        command = ['bash', '-c', "source /opt/miniconda3/bin/activate testbed && export PYTHONDONTWRITEBYTECODE=1 PYTEST_ADDOPTS='-o cache_dir=/tmp/forge-pytest-cache' FORGE_AGENT_HOME=/tmp/forge-home PFORGE_HOME=/tmp/forge-home PI_CODING_AGENT_DIR=/tmp/forge-home PI_CODING_AGENT_SESSION_DIR=/tmp/forge-home/sessions && exec node /opt/forge/agent.mjs"]
        # Exec is bounded in the agent and by the controller's container timeout.
        from swebench.harness.docker_utils import exec_run_with_timeout
        import shlex
        logs, timed_out, duration = exec_run_with_timeout(container, shlex.join(command), request['limits']['maxDurationMs'] / 1000 + 180)
        (output / 'agent.log').write_text(logs, encoding='utf-8')
        if timed_out:
            raise RuntimeError('Agent container deadline exceeded')
        for name in ('result.json', 'prediction.patch'):
            (output / name).write_bytes(take_bytes(container, '/tmp/forge-output/' + name))
        try:
            (output / 'snapshot.json').write_bytes(take_bytes(container, '/tmp/forge-output/snapshot.json'))
        except Exception as error:
            (output / 'snapshot-unavailable.txt').write_text(str(error))
        result = json.loads((output / 'result.json').read_text())
        result['runnerImageId'] = image.id
        return result
    finally:
        container.remove(force=True)
        ACTIVE.remove(container)

def dispatch(request):
    readiness = doctor()
    if request['action'] == 'doctor':
        return readiness
    if not readiness['ready']:
        raise RuntimeError('; '.join(readiness['errors']))
    import docker
    client = docker.from_env(timeout=1800)
    try:
        if request['action'] == 'validate':
            return validation(request, client, readiness['harness'])
        if request['action'] == 'node-image':
            # Resolve a tag once; every execution thereafter uses the image ID.
            expected = request.get('expected')
            if expected:
                try:
                    image = client.images.get(expected['imageId'])
                except Exception:
                    digests = expected.get('repoDigests', [])
                    if not digests or '@sha256:' not in digests[0]:
                        raise RuntimeError('Cannot recover the pinned Node image')
                    image = client.images.pull(digests[0], platform='linux/amd64')
                if image.id != expected['imageId']:
                    raise RuntimeError('Resumed Node image fingerprint mismatch')
            else:
                image = client.images.pull('node:22.21.1-bookworm-slim', platform='linux/amd64')
            return {'imageId': image.id, 'imageRef': 'node:22.21.1-bookworm-slim', 'repoDigests': image.attrs.get('RepoDigests', [])}
        if request['action'] == 'agent':
            return agent_run(request, client)
        if request['action'] == 'grade':
            record = json.loads(Path(request['record']).read_text())
            image = client.images.get(request['imageId'])
            if image.id != request['imageId']:
                raise RuntimeError('Validated task image is unavailable')
            prediction = Path(request['patch']).read_text()
            return official_grade(client, record, image.id, prediction, request['output'], request['timeout'], baseline=not prediction.strip())
        raise RuntimeError('Unknown SWE-bench backend action')
    finally:
        client.close()

def stop(signum, frame):
    for container in ACTIVE:
        try:
            container.remove(force=True)
        except Exception:
            pass
    raise SystemExit(128 + signum)

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    request = json.loads(Path(sys.argv[1]).read_text())
    try:
        answer = dispatch(request)
        save(sys.argv[2], answer)
        if request['action'] == 'doctor' and not answer['ready']:
            sys.exit(2)
    except Exception as error:
        save(sys.argv[2], {'infrastructureFailure': True, 'error': str(error)})
        print('SWE-bench infrastructure failure: ' + str(error), file=sys.stderr)
        sys.exit(2)
