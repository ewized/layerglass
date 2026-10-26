"""Deterministic DVR ownership, failure and retention fixtures."""

import errno
import json
from pathlib import Path
import tempfile
import threading
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


if __name__ == '__main__':
    unittest.main()
