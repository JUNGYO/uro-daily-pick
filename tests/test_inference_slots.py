"""Exercise actual cross-process locking, including the historical byte lock."""
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from inference_slots import inference_access, _try_lock, _unlock


CHILD = r'''
import sys,time
from pathlib import Path
from contextlib import contextmanager
from inference_slots import inference_access
root=Path(sys.argv[1]);mode=sys.argv[2];deadline=time.monotonic()+float(sys.argv[3])
def remaining(deadline, maximum=600):
    left=deadline-time.monotonic()
    if left<=0:raise TimeoutError()
    return min(maximum,left)
@contextmanager
def legacy():
    with (root/'literature-inference.lock').open('a+b') as handle:
        while True:
            remaining(deadline)
            try:
                if sys.platform=='win32':
                    import msvcrt
                    handle.seek(0);msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
                break
            except OSError:time.sleep(.025)
        yield
try:
    with legacy() if mode=='legacy' else inference_access(root,deadline,remaining,shared=mode=='shared'):
        print('ready',flush=True);sys.stdin.readline()
except TimeoutError:print('timeout',flush=True)
'''


class InferenceSlotsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'literature-inference.lock').write_bytes(b'0')
        self.children = []
        self.env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / 'scripts'))

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.communicate('\n', timeout=6)
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()
        self.temp.cleanup()

    def spawn(self, mode, seconds=3):
        child = subprocess.Popen([sys.executable, '-c', CHILD, str(self.root), mode, str(seconds)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, env=self.env)
        self.children.append(child)
        return child

    def ready(self, mode):
        child = self.spawn(mode)
        self.assertEqual(child.stdout.readline().strip(), 'ready', child.stderr.read() if child.poll() is not None else '')
        return child

    def blocked(self, mode):
        child = self.spawn(mode, .25)
        output, error = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 0, error)
        self.assertEqual(output.strip(), 'timeout', error)

    def release(self, child):
        child.communicate('\n', timeout=5)
        self.assertEqual(child.returncode, 0)

    def test_two_shared_requests_overlap_but_third_cannot_enter(self):
        one = self.ready('shared')
        two = self.ready('shared')
        self.blocked('shared')
        self.blocked('exclusive')
        self.release(one)
        three = self.ready('shared')
        self.release(two)
        self.release(three)
        self.release(self.ready('exclusive'))

    def test_legacy_exclusive_and_new_shared_locks_interoperate_both_directions(self):
        old = self.ready('legacy')
        self.blocked('shared')
        self.release(old)
        new = self.ready('shared')
        self.blocked('legacy')
        self.release(new)
        self.release(self.ready('legacy'))

    def test_waiting_research_stops_new_summary_admission_then_recovers(self):
        summary = self.ready('shared')
        research = self.spawn('exclusive', 5)
        limit = time.monotonic() + 3
        with (self.root / 'literature-inference-admission.lock').open('a+b') as gate:
            while _try_lock(gate):
                _unlock(gate)
                self.assertLess(time.monotonic(), limit)
                time.sleep(.02)
        self.blocked('shared')
        self.release(summary)
        self.assertEqual(research.stdout.readline().strip(), 'ready')
        self.blocked('shared')
        self.release(research)
        self.release(self.ready('shared'))

    def test_expired_attempt_releases_all_slot_and_admission_handles(self):
        def expired(*args):
            raise TimeoutError()
        for shared in (True, False):
            with self.assertRaises(TimeoutError):
                with inference_access(self.root, 0, expired, shared=shared):
                    self.fail('Expired request entered')
        self.release(self.ready('exclusive'))
        self.release(self.ready('shared'))


if __name__ == '__main__':
    unittest.main()
