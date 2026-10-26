"""Deterministic DVR ownership, failure and retention fixtures."""

import errno
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import ViewerServer
from replay import ReplayBuffer
from test_replay import CAMERA, Registry, Source


class ObservedLock:
    """Signal a worker's lock attempt without depending on scheduler timing."""

    def __init__(self, lock):
        self.lock = lock
        self.waiter = None
        self.waiting = threading.Event()

    def __enter__(self):
        if threading.current_thread() is self.waiter:
            self.waiting.set()
        return self.lock.__enter__()

    def __exit__(self, *args):
        return self.lock.__exit__(*args)


class ReplayPruningTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = Source(self.root)
        self.source.publish([1, 2, 3])
        self.registry = Registry(self.source)
        self.replay = ReplayBuffer(self.registry, root=self.root / 'buffer', timeout=60)
        self.worker_errors = []
        hook = patch('threading.excepthook', side_effect=lambda args: self.worker_errors.append(args.exc_value))
        hook.start()
        self.addCleanup(hook.stop)
        self.replay.start()
        self.addCleanup(self.replay.close)
        self.token = self.replay.create(CAMERA)['session_id']
        self.archive = self.replay.archives[CAMERA]
        self.server = ViewerServer(('127.0.0.1', 0), registry=self.registry, replay=self.replay)
        self.addCleanup(self.server.server_close)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def wait_for(self, predicate):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            self.assertTrue(self.replay.thread.is_alive(), f'DVR worker stopped: {self.worker_errors!r}')
            with self.replay.lock:
                if predicate():
                    return
            time.sleep(0.01)
        self.fail('DVR maintenance did not reach the expected state.')

    def http(self, path):
        with urlopen(self.base + path, timeout=2) as response:
            return response.read()

    def assert_tracked(self):
        files = {item.file for item in self.archive.fragments}
        self.assertEqual(files, set(self.archive.directory.iterdir()))
        self.assertEqual(sum(item.size for item in self.archive.fragments), sum(file.stat().st_size for file in files))
        self.assertFalse(self.worker_errors)

    def test_real_cap_unlink_failure_keeps_worker_and_ownership_then_recovers(self):
        if os.geteuid() == 0:
            self.skipTest('The real directory permission fault requires a non-root runtime.')
        with self.replay.lock:
            self.source.publish([3, 4, 5])
            self.replay._collect(self.archive, self.source)
            original = self.archive.fragments[0].file
            self.replay.max_bytes = 20
            with patch.object(self.replay, '_sprite', return_value=b'\xff\xd8fixture\xff\xd9'):
                self.assertIsNotNone(self.replay.preview(self.token, 0))
            self.assertTrue(self.replay.previews)
            self.archive.directory.chmod(0o500)
        try:
            self.wait_for(lambda: self.archive.error is not None)
            self.assertIn(original, {item.file for item in self.archive.fragments})
            self.assertTrue(original.exists())
            self.assertEqual(json.loads(self.http('/healthz')), {'ok': True})
            self.assert_tracked()
        finally:
            self.archive.directory.chmod(0o700)
        self.source.publish([5, 6, 7])
        self.wait_for(lambda: self.replay.status(self.token)['end_seconds'] >= 10)
        with self.replay.lock:
            self.assertFalse(original.exists())
            self.assertFalse(self.replay.previews)
            self.assertIsNone(self.archive.error)
            self.assertLessEqual(sum(item.size for item in self.archive.fragments), 20)
            self.assertTrue(self.replay.status(self.token)['limited'])
            self.assert_tracked()

    def test_unlink_only_failure_pauses_growth_with_writable_appends_and_recovers(self):
        later = self.replay.create(CAMERA)['session_id']
        with self.replay.lock:
            self.source.publish([3, 4, 5])
            self.replay._collect(self.archive, self.source)
            original = self.archive.fragments[0].file
            self.replay.max_bytes = 20
        attempts = []
        unlink = Path.unlink

        def deny_original(path, *args, **kwargs):
            if path == original:
                attempts.append(path)
                raise PermissionError(errno.EACCES, 'Fixture unlink-only failure.')
            return unlink(path, *args, **kwargs)

        with patch.object(Path, 'unlink', deny_original):
            self.wait_for(lambda: bool(attempts))
            with self.replay.lock:
                files = set(self.archive.directory.iterdir())
                size = sum(item.size for item in self.archive.fragments)
                sequence = self.archive.sequence
            for last in range(6, 14):
                with self.replay.lock:
                    count = len(attempts)
                    self.source.publish(range(last - 2, last + 1))
                    # Denying only the oldest unlink leaves new writes possible;
                    # chmod alone would not catch a naive catch-and-append fix.
                    writable = self.archive.directory / 'writable-probe'
                    writable.write_bytes(b'new recording writes remain possible')
                    writable.unlink()
                self.wait_for(lambda: len(attempts) > count)
                with self.replay.lock:
                    self.assertEqual(self.archive.sequence, sequence)
                    self.assertEqual(set(self.archive.directory.iterdir()), files)
                    self.assertEqual(sum(item.size for item in self.archive.fragments), size)
                    self.assert_tracked()
                began = time.monotonic()
                metadata = json.loads(self.http(f'/api/sessions/{later}'))
                self.assertTrue(metadata['ready'])
                self.assertEqual(self.http(f'/replay/{later}/segment-2.ts'), b'frame-a-5')
                self.assertEqual(json.loads(self.http('/healthz')), {'ok': True})
                self.assertLess(time.monotonic() - began, 1)
        self.wait_for(lambda: self.archive.sequence > sequence)
        with self.replay.lock:
            self.assertIsNotNone(self.replay.status(later))
            self.assertIsNotNone(self.replay.status(self.token))
            self.assertFalse(original.exists())
            self.assertIsNone(self.archive.error)
            self.assertLessEqual(sum(item.size for item in self.archive.fragments), 20)
            self.assert_tracked()

    def test_failed_old_page_release_keeps_files_tracked_for_worker_retry(self):
        if os.geteuid() == 0:
            self.skipTest('The real directory permission fault requires a non-root runtime.')
        with self.replay.lock:
            self.source.publish([3, 4, 5])
            self.replay._collect(self.archive, self.source)
            later = self.replay.create(CAMERA)['session_id']
            self.source.publish([5, 6])
            self.replay._collect(self.archive, self.source)
            original = self.archive.fragments[0].file
            self.archive.directory.chmod(0o500)
        try:
            with self.assertRaises(PermissionError):
                self.replay.release(self.token)
            self.assertIsNone(self.replay.status(self.token))
            self.assertEqual(self.archive.fragments[0].file, original)
            self.wait_for(lambda: self.archive.error is not None)
            self.assertTrue(json.loads(self.http(f'/api/sessions/{later}'))['ready'])
            self.assert_tracked()
        finally:
            self.archive.directory.chmod(0o700)
        self.source.publish([6, 7])
        self.wait_for(lambda: self.replay.status(later)['end_seconds'] >= 4)
        with self.replay.lock:
            self.assertFalse(original.exists())
            self.assertFalse(self.replay.status(later)['limited'])
            self.assertIsNone(self.archive.error)
            self.assertEqual(self.archive.fragments[0].sequence, self.replay.sessions[later].first)
            self.assert_tracked()


class ReplayLifecycleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = Source(self.root)
        self.source.publish([1, 2, 3])
        self.registry = Registry(self.source)
        self.replay = ReplayBuffer(self.registry, root=self.root / 'buffer', timeout=10)
        # These tests drive collection directly; no background worker races the
        # injected failures or deliberately held locks.
        self.replay.root.mkdir(parents=True)
        self.addCleanup(self.replay.close)

    def test_failed_initial_copy_does_not_consume_viewer_slots(self):
        failure = OSError(errno.ENOSPC, 'Fixture storage is full.')
        with patch('replay.shutil.copyfile', side_effect=failure):
            for _ in range(129):
                with self.assertRaises(OSError) as error:
                    self.replay.create(CAMERA)
                self.assertIs(error.exception, failure)
                self.assertFalse(self.replay.sessions)
                self.assertFalse(self.replay.archives)
                self.assertEqual(list(self.replay.root.iterdir()), [])
        replacement = self.replay.create(CAMERA)
        self.assertTrue(replacement['ready'])
        self.assertEqual(len(self.replay.sessions), 1)

    def test_telemetry_and_metadata_failures_release_the_new_session(self):
        for method, failure in (('_collect_printer', ValueError('Fixture telemetry failure.')),
                                ('_metadata', RuntimeError('Fixture metadata failure.'))):
            with self.subTest(method=method):
                with patch.object(self.replay, method, side_effect=failure):
                    with self.assertRaises(type(failure)) as error:
                        self.replay.create(CAMERA)
                self.assertIs(error.exception, failure)
                self.assertFalse(self.replay.sessions)
                self.assertFalse(self.replay.archives)
                self.assertEqual(list(self.replay.root.iterdir()), [])
                replacement = self.replay.create(CAMERA)
                self.assertTrue(replacement['ready'])
                self.replay.release(replacement['session_id'])

    def test_failed_later_tab_keeps_the_existing_archive_and_history(self):
        token = self.replay.create(CAMERA)['session_id']
        archive = self.replay.archives[CAMERA]
        original = self.replay.media(token, sequence=0)
        self.source.publish([3, 4])
        with patch('replay.shutil.copyfile', side_effect=OSError(errno.ENOSPC, 'Fixture storage is full.')):
            with self.assertRaises(OSError):
                self.replay.create(CAMERA)
        self.assertEqual(list(self.replay.sessions), [token])
        self.assertIs(self.replay.archives[CAMERA], archive)
        self.assertEqual(original.read_bytes(), b'frame-a-3')
        self.assertEqual(self.replay.status(token)['end_seconds'], 2)
        replacement = self.replay.create(CAMERA)
        self.assertTrue(replacement['ready'])
        self.assertEqual(self.replay.status(token)['end_seconds'], 4)

    def test_rollback_cleanup_does_not_replace_the_original_error(self):
        token = self.replay.create(CAMERA)['session_id']
        failure = ValueError('Fixture collection failure.')
        with patch.object(self.replay, '_collect_printer', side_effect=failure), \
                patch.object(self.replay, '_prune', side_effect=[None, OSError('Fixture cleanup failure.')]), \
                self.assertLogs('printer-camera', level='WARNING'):
            with self.assertRaises(ValueError) as error:
                self.replay.create(CAMERA)
        self.assertIs(error.exception, failure)
        self.assertEqual(list(self.replay.sessions), [token])
        self.assertEqual(self.replay.media(token, sequence=0).read_bytes(), b'frame-a-3')

    def test_http_create_can_retry_after_storage_recovers(self):
        server = ViewerServer(('127.0.0.1', 0), registry=self.registry, replay=self.replay)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        request = Request(f'http://127.0.0.1:{server.server_port}/api/sessions',
                          data=json.dumps({'camera_id': CAMERA}).encode(),
                          headers={'X-Viewer-Request': '1'})
        with patch('replay.shutil.copyfile', side_effect=OSError(errno.ENOSPC, 'Fixture storage is full.')):
            with self.assertRaises(HTTPError) as error:
                urlopen(request, timeout=3)
            self.assertEqual(error.exception.code, 503)
            error.exception.close()
        self.assertFalse(self.replay.sessions)
        with urlopen(request, timeout=3) as response:
            self.assertEqual(response.status, 201)
            self.assertTrue(json.load(response)['ready'])

    def test_forget_before_admission_rejects_a_waiting_create(self):
        old = self.replay.create(CAMERA)['session_id']
        original = self.replay.media(old, sequence=0)
        observed = self.replay.lock = ObservedLock(self.replay.lock)
        created, errors = [], []

        def create():
            try:
                created.append(self.replay.create(CAMERA))
            except Exception as error:
                errors.append(error)

        worker = observed.waiter = threading.Thread(target=create, daemon=True)
        with observed:
            worker.start()
            self.assertTrue(observed.waiting.wait(3))
            # Model registry.forget followed by replay.forget, as in the HTTP
            # handler, while the queued create has not acquired the DVR lock.
            self.registry.source = None
            self.replay.forget(CAMERA)
            self.assertFalse(original.exists())
        worker.join(timeout=3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(created, [])
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ValueError)
        self.assertFalse(self.replay.sessions)
        self.assertFalse(self.replay.archives)
        self.assertEqual(list(self.replay.root.iterdir()), [])

    def test_forget_after_admission_releases_the_completed_create(self):
        observed = self.replay.lock = ObservedLock(self.replay.lock)
        entered, finish = threading.Event(), threading.Event()
        created, errors = [], []
        collect = self.replay._collect

        def hold_collection(*args):
            entered.set()
            if not finish.wait(3):
                raise RuntimeError('Fixture collection was not released.')
            return collect(*args)

        def create():
            try:
                created.append(self.replay.create(CAMERA))
            except Exception as error:
                errors.append(error)

        def forget():
            try:
                self.replay.forget(CAMERA)
            except Exception as error:
                errors.append(error)

        creator = threading.Thread(target=create, daemon=True)
        forgetter = observed.waiter = threading.Thread(target=forget, daemon=True)
        with patch.object(self.replay, '_collect', side_effect=hold_collection):
            creator.start()
            try:
                self.assertTrue(entered.wait(3))
                self.registry.source = None
                forgetter.start()
                self.assertTrue(observed.waiting.wait(3))
            finally:
                finish.set()
                creator.join(timeout=3)
                if forgetter.ident is not None:
                    forgetter.join(timeout=3)
        self.assertFalse(creator.is_alive())
        self.assertFalse(forgetter.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(created), 1)
        self.assertTrue(created[0]['ready'])
        self.assertIsNone(self.replay.status(created[0]['session_id']))
        self.assertFalse(self.replay.archives)
        self.assertEqual(list(self.replay.root.iterdir()), [])

    def test_rolling_manifest_bookkeeping_stays_bounded_after_retention(self):
        token = self.replay.create(CAMERA)['session_id']
        archive = self.replay.archives[CAMERA]
        self.assertEqual(self.replay.media(token, sequence=0).read_bytes(), b'frame-a-3')
        self.replay.max_bytes = 25
        for last in range(4, 1004):
            numbers = range(last - 2, last + 1)
            self.source.publish(numbers)
            self.replay._collect(archive, self.source)
            self.replay._prune()
            self.assertLessEqual(len(archive.seen), len(numbers))
        self.assertLessEqual(len(archive.fragments), 2)
        self.assertEqual(archive.sequence, 1001)
        self.assertTrue(self.replay.status(token)['limited'])
        self.assertIsNone(self.replay.media(token, sequence=0))
        for _ in range(10):
            self.replay._collect(archive, self.source)
        self.assertEqual(archive.sequence, 1001, 'An unchanged manifest must not duplicate footage.')
        self.assertEqual(self.replay.media(token, sequence=1000).read_bytes(), b'frame-a-1003')

    def test_bounded_names_preserve_new_page_and_reconnect_boundaries(self):
        first = self.replay.create(CAMERA)['session_id']
        archive = self.replay.archives[CAMERA]
        self.source.publish(range(3, 8))
        self.replay._collect(archive, self.source)
        previous = archive.sequence - 1
        later = self.replay.create(CAMERA)['session_id']
        self.assertFalse(self.replay.status(later)['ready'])
        self.assertIsNone(self.replay.media(later, sequence=previous))
        self.assertEqual(self.replay.media(first, sequence=previous).read_bytes(), b'frame-a-7')
        self.source.generation = 'b' * 32
        self.source.directory = self.root / self.source.generation
        self.source.directory.mkdir()
        # A reconnect can reuse source names still in the old manifest. Each
        # belongs to new footage, unlike an unchanged manifest in one generation.
        self.source.publish([5, 6, 7])
        self.replay._collect(archive, self.source)
        self.replay._prune()
        self.assertEqual(archive.sequence, previous + 4)
        self.assertLessEqual(len(archive.seen), 3)
        self.assertEqual(self.replay.media(first, sequence=previous).read_bytes(), b'frame-a-7')
        self.assertEqual(self.replay.media(later, sequence=previous + 1).read_bytes(), b'frame-b-5')
        self.assertIsNone(self.replay.media(later, sequence=previous))
        index, _ = self.replay.video_update(later)
        self.assertTrue(index['segments'][0]['discontinuity'])
        self.assertEqual([item['sequence'] for item in index['segments']], list(range(previous + 1, previous + 4)))


if __name__ == '__main__':
    unittest.main()
