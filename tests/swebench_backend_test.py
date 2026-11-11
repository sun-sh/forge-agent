"""Unit fixtures for the controller boundary; not Docker or real-model evidence."""
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('forge_swebench_backend', ROOT / 'scripts/swebench-backend.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)

class Container:
    removed = False
    def remove(self, force=False):
        self.removed = True

class OfficialBoundary(unittest.TestCase):
    def run_fixture(self, resolved=False, statuses=None, found=True, patch_fail=False, baseline=False):
        record = {'instance_id': 'owner__repo-1', 'FAIL_TO_PASS': ['new'], 'PASS_TO_PASS': ['old']}
        statuses = {'new': 'FAILED', 'old': 'PASSED'} if statuses is None else statuses
        tests = {'FAIL_TO_PASS': {'success': ['new'] if resolved else [], 'failure': [] if resolved else ['new']}, 'PASS_TO_PASS': {'success': ['old'], 'failure': []}}
        official = types.ModuleType('swebench.harness.run_evaluation')
        official.create_container = None
        official.RUN_EVALUATION_LOG_DIR = Path('logs/evaluation')
        official.APPLY_PATCH_FAIL = '>>>>> Patch Apply Failed'
        calls = []
        def fake_run(test_spec, prediction, client, run_id, **kwargs):
            calls.append(kwargs)
            official.create_container(test_spec, client, run_id, None)
            directory = official.RUN_EVALUATION_LOG_DIR / run_id / 'forge-evaluation' / record['instance_id']
            directory.mkdir(parents=True)
            (directory / 'run_instance.log').write_text(official.APPLY_PATCH_FAIL if patch_fail else 'wrapper exited zero')
            if patch_fail:
                return None
            (directory / 'test_output.txt').write_text('fixture output')
            answer = {record['instance_id']: {'resolved': resolved, 'infra_failure': False, 'tests_status': tests}}
            (directory / 'report.json').write_text(json.dumps(answer))
            return record['instance_id'], answer
        official.run_instance = fake_run
        utils = types.ModuleType('swebench.harness.utils')
        utils.make_test_spec = lambda row: types.SimpleNamespace(image=row['image'])
        grading = types.ModuleType('swebench.harness.grading')
        grading._resolve_case = lambda case, mapping: case if case in mapping else None
        grading.get_logs_eval = lambda *_: (statuses, found)
        harness = types.ModuleType('swebench.harness')
        harness.run_evaluation = official
        modules = {'swebench': types.ModuleType('swebench'), 'swebench.harness': harness, 'swebench.harness.run_evaluation': official, 'swebench.harness.utils': utils, 'swebench.harness.grading': grading}
        options = []
        containers = []
        def create(**kwargs):
            options.append(kwargs)
            container = Container()
            containers.append(container)
            return container
        client = types.SimpleNamespace(containers=types.SimpleNamespace(create=create))
        with tempfile.TemporaryDirectory() as path, patch.dict(sys.modules, modules):
            result = backend.official_grade(client, record, 'sha256:' + 'a' * 64, 'model patch', Path(path) / 'grade', 60, baseline)
        self.assertTrue(all(container.removed for container in containers))
        self.assertEqual(options[0]['cap_drop'], ['ALL'])
        self.assertNotIn('volumes', options[0])
        self.assertNotIn('cap_add', options[0])
        self.assertNotIn('privileged', options[0])
        return result, calls

    def test_wrapper_zero_does_not_override_official_unresolved(self):
        result, _ = self.run_fixture()
        self.assertTrue(result['valid'])
        self.assertFalse(result['resolved'])

    def test_baseline_requires_all_actual_failures_and_maintained_tests(self):
        result, calls = self.run_fixture(baseline=True)
        self.assertTrue(result['baselineExpectedFailure'])
        self.assertTrue(calls[0]['skip_patch'])
        result, _ = self.run_fixture(statuses={'new': 'SKIPPED', 'old': 'PASSED'}, baseline=True)
        self.assertFalse(result['baselineExpectedFailure'])

    def test_missing_tests_and_unparsed_logs_are_not_valid_baselines(self):
        result, _ = self.run_fixture(statuses={'old': 'PASSED'}, baseline=True)
        self.assertFalse(result['valid'])
        self.assertFalse(result['baselineExpectedFailure'])
        result, _ = self.run_fixture(found=False, baseline=True)
        self.assertFalse(result['valid'])

    def test_reference_success_requires_actual_official_report_and_observed_tests(self):
        result, _ = self.run_fixture(resolved=True, statuses={'new': 'PASSED', 'old': 'PASSED'})
        self.assertTrue(result['valid'])
        self.assertTrue(result['resolved'])
        self.assertFalse(result['baselineExpectedFailure'])

    def test_rejected_patch_is_identified_without_a_fake_test_score(self):
        result, _ = self.run_fixture(patch_fail=True)
        self.assertFalse(result['valid'])
        self.assertIsNone(result['resolved'])
        self.assertTrue(result['patchRejected'])

if __name__ == '__main__':
    unittest.main()
