"""Exercise controller ordering against a real synthetic quota ledger; no network."""
from contextlib import redirect_stdout
from datetime import datetime, timedelta
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import institution_entry as entry
from acquisition_quota import AcquisitionDeferred, PUBLISHERS, Quota, initialize


class OriginalFirstTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.policy = self.state / 'acquisition-policy.json'
        self.policy.write_text(json.dumps({'version': 1, 'timezone': 'Asia/Seoul',
            'starts_at': '2026-10-13T00:00:00+09:00', 'daily_limit': 30, 'manual_reserve': 0}))
        initialize(self.policy)
        self.now = datetime.fromisoformat('2026-10-13T12:27:27+09:00')
        self.elapsed = 0
        self.quota = Quota(self.policy, now=lambda: self.now)
        self.events, self.commands = [], {}
        self.collect_result, self.collect_timeout = 0, False
        self.collect_seconds = 3300
        self.after_collect = lambda: None
        self.on_figures = lambda: None
        self.output = io.StringIO()

    def run_controller(self):
        owner = self

        class Child:
            def __init__(self, phase):
                self.phase, self.returncode = phase, None

            def poll(self):
                return self.returncode

            def wait(self, timeout):
                owner.events.append(('wait', self.phase))
                if self.phase == 'collect':
                    owner.elapsed += owner.collect_seconds
                    owner.now += timedelta(seconds=owner.collect_seconds)
                    owner.after_collect()
                    if owner.collect_timeout:
                        raise subprocess.TimeoutExpired('synthetic', timeout)
                    self.returncode = owner.collect_result
                else:
                    self.returncode = 0
                return self.returncode

        def launch(command, **kwargs):
            phase = command[command.index('--phase') + 1] if '--phase' in command else {
                'knowledge_worker.py': 'knowledge', 'local_catalog_worker.py': 'catalog',
                'catalog_sync.py': 'sync'}[Path(command[2]).name]
            self.events.append(('start', phase))
            self.commands[phase] = command
            self.assertEqual(kwargs['env']['URO_ACQUISITION_POLICY'], str(self.policy))
            if phase == 'figures':
                self.assertIn(('wait', 'collect'), self.events)
                self.on_figures()
            return Child(phase)

        def stop(child):
            self.events.append(('stop', child.phase))
            child.returncode = 1

        with patch.object(entry, 'Quota', return_value=self.quota), \
             patch.object(entry.time, 'monotonic', side_effect=lambda: self.elapsed), \
             patch.object(entry.subprocess, 'Popen', side_effect=launch), \
             patch.object(entry, 'stop_child', side_effect=stop), redirect_stdout(self.output):
            return entry.run_phases(self.state, self.state)

    def test_collection_owns_budget_before_figures_and_other_work_starts_immediately(self):
        self.after_collect = lambda: self.quota.reserve(['wiley'], amount=28)

        def figures():
            self.assertEqual(self.quota.status()['publishers']['wiley']['remaining'], 2)
            self.quota.reserve(['wiley'], amount=2)
            with self.assertRaises(AcquisitionDeferred):
                self.quota.reserve(['wiley'])
        self.on_figures = figures
        self.assertFalse(any(self.run_controller()))
        waited = self.events.index(('wait', 'collect'))
        for phase in ('catalog', 'sync', 'summarize', 'research', 'knowledge'):
            self.assertLess(self.events.index(('start', phase)), waited)
        self.assertLess(self.events.index(('wait', 'figures')), self.events.index(('wait', 'sync')))
        command = self.commands['figures']
        self.assertEqual(int(command[command.index('--max-seconds') + 1]), 165)
        self.assertEqual(self.quota.status()['publishers']['wiley']['automatic'], 30)

    def test_exhausted_budget_skips_figures_and_survives_controller_restart(self):
        self.after_collect = lambda: self.quota.reserve(PUBLISHERS, amount=30)
        self.run_controller()
        self.assertNotIn('figures', self.commands)
        self.assertIn('quota_daily_limit', self.output.getvalue())
        self.after_collect = lambda: None
        self.run_controller()
        self.assertNotIn('figures', self.commands)
        self.assertTrue(all(p['automatic'] == 30 for p in self.quota.status()['publishers'].values()))

    def test_collection_failure_does_not_release_budget_to_figures(self):
        self.collect_result = 1
        self.assertTrue(any(self.run_controller()))
        self.assertNotIn('figures', self.commands)
        self.assertIn('originals_first_collection_failed', self.output.getvalue())

    def test_collection_timeout_stops_only_owned_child_and_skips_figures(self):
        self.collect_timeout = True
        self.assertTrue(any(self.run_controller()))
        self.assertEqual([x for x in self.events if x[0] == 'stop'], [('stop', 'collect')])
        self.assertNotIn('figures', self.commands)

    def test_no_time_remaining_skips_figures_without_extending_hourly_run(self):
        self.collect_seconds = 3460
        self.run_controller()
        self.assertNotIn('figures', self.commands)
        self.assertIn('originals_first_no_time', self.output.getvalue())

    def test_midnight_does_not_give_figures_next_days_untried_original_budget(self):
        self.now = datetime.fromisoformat('2026-10-13T23:27:27+09:00')
        self.run_controller()
        self.assertNotIn('figures', self.commands)
        self.assertIn('originals_first_new_day', self.output.getvalue())
        self.assertTrue(all(p['automatic'] == 0 for p in self.quota.status()['publishers'].values()))

    def test_early_completion_near_midnight_bounds_figure_window(self):
        self.now = datetime.fromisoformat('2026-10-13T23:59:00+09:00')
        self.collect_seconds = 10
        self.run_controller()
        command = self.commands['figures']
        self.assertEqual(int(command[command.index('--max-seconds') + 1]), 35)

    def test_pause_during_collection_skips_figures(self):
        def pause():
            config = json.loads(self.policy.read_text())
            config['paused'] = True
            self.policy.write_text(json.dumps(config))
        self.after_collect = pause
        self.run_controller()
        self.assertNotIn('figures', self.commands)
        self.assertIn('quota_not_started', self.output.getvalue())

    def test_missing_ledger_preserves_other_work_without_reinitializing(self):
        ledger = self.state / 'acquisition-quota.sqlite3'
        ledger.unlink()
        self.run_controller()
        self.assertEqual(set(self.commands), {'catalog', 'sync', 'summarize', 'research', 'knowledge'})
        self.assertFalse(ledger.exists())

    def test_before_start_date_keeps_both_download_phases_paused(self):
        self.now = datetime.fromisoformat('2026-10-12T12:27:27+09:00')
        self.run_controller()
        self.assertEqual(set(self.commands), {'catalog', 'sync', 'summarize', 'research', 'knowledge'})


if __name__ == '__main__':
    unittest.main()
