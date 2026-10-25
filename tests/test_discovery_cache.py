from copy import deepcopy
import threading
import unittest
from unittest.mock import Mock, patch

from discovery import Discovery, ProbeCache
from providers import approved_camera, endpoint


HOST = '192.168.50.2'
KEY = (HOST, 322, 'rtsps')
PRINTER = dict(endpoint(f'rtsps://{HOST}:322/', provider='bambu'),
               model='N6', serial='20P000000000001', identification='mqtt')


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class ProbeCacheTests(unittest.TestCase):
    def test_failed_endpoints_back_off_15_30_60_seconds_and_stay_capped(self):
        cache = ProbeCache()
        now = 0
        for delay in [15, 30, 60, 60, 60]:
            cache.put(KEY, None, now)
            self.assertEqual(cache.get(KEY, now + delay - 0.001), (True, None))
            self.assertEqual(cache.get(KEY, now + delay), (False, None))
            now += delay

    def test_success_expires_after_twenty_seconds_and_resets_failure_backoff(self):
        cache = ProbeCache()
        cache.put(KEY, None, 0)
        cache.put(KEY, None, 15)
        cache.put(KEY, None, 45)
        cache.put(KEY, PRINTER, 105)
        self.assertEqual(cache.entries[KEY].failures, 0)
        self.assertEqual(cache.get(KEY, 124.999), (True, PRINTER))
        self.assertEqual(cache.get(KEY, 125), (False, None))
        cache.put(KEY, None, 125)
        self.assertEqual(cache.entries[KEY].retry_at, 140)

    def test_old_failure_history_expires_instead_of_penalizing_an_idle_scanner(self):
        cache = ProbeCache()
        cache.put(KEY, None, 0)
        cache.put(KEY, None, 15)
        self.assertEqual(cache.get(KEY, 315), (False, None))
        cache.put(KEY, None, 315)
        self.assertEqual(cache.entries[KEY].retry_at, 330)

    def test_cache_is_bounded_and_recent_access_protects_an_entry(self):
        cache = ProbeCache()
        cache.LIMIT = 3
        keys = [(f'192.168.50.{index}', 322, 'rtsps') for index in range(1, 5)]
        for key in keys[:3]:
            cache.put(key, None, 0)
        cache.get(keys[0], 1)
        cache.put(keys[3], None, 2)
        self.assertEqual(len(cache.entries), 3)
        self.assertIn(keys[0], cache.entries)
        self.assertNotIn(keys[1], cache.entries)

    def test_nested_public_values_are_not_shared_with_a_cache_consumer(self):
        cache = ProbeCache()
        item = deepcopy(PRINTER)
        cache.put(KEY, item, 0)
        item['setup']['type'] = 'changed'
        result = cache.get(KEY, 1)[1]
        self.assertEqual(result['setup']['type'], 'access_code')
        result['setup']['type'] = 'also changed'
        self.assertEqual(cache.get(KEY, 2)[1]['setup']['type'], 'access_code')


class DiscoveryCacheTests(unittest.TestCase):
    def scanner(self, cidrs=f'{HOST}/32'):
        clock = Clock()
        scanner = Discovery('', cidrs, clock=clock)
        self.addCleanup(scanner.close)
        return scanner, clock

    def scan(self, scanner):
        self.assertTrue(scanner.start())
        scanner.thread.join(3)
        self.assertFalse(scanner.thread.is_alive(), 'A bounded scan must finish.')
        return scanner.status()

    @staticmethod
    def printer(host, port, kind):
        return deepcopy(PRINTER) if (host, port, kind) == KEY else None

    def test_warm_scans_reuse_results_names_and_do_not_open_network_connections(self):
        scanner, clock = self.scanner()
        with patch.object(scanner, '_probe', side_effect=self.printer) as probe, \
                patch('discovery.discover_names', return_value={HOST: {'name': 'Workshop'}}) as names:
            first = self.scan(scanner)
            self.assertEqual((first['probed'], first['cached'], first['checked']), (2, 0, 2))
            clock.advance(10)
            second = self.scan(scanner)
            self.assertEqual((second['probed'], second['cached'], second['checked']), (0, 2, 2))
            self.assertTrue(second['names_cached'])
            self.assertEqual(first['found'], second['found'])
            self.assertNotEqual(first['scan_id'], second['scan_id'])
            self.assertEqual(probe.call_count, 2)
            self.assertEqual(names.call_count, 1)
            clock.advance(1000)
            scanner.status()
            self.assertEqual(probe.call_count, 2, 'Expired cache entries must not schedule an automatic scan.')

    def test_expiry_revalidates_success_and_retries_failed_ports(self):
        scanner, clock = self.scanner()
        with patch.object(scanner, '_probe', side_effect=self.printer) as probe, patch('discovery.discover_names', return_value={}):
            self.scan(scanner)
            clock.advance(20)
            result = self.scan(scanner)
            self.assertEqual((result['probed'], result['cached']), (2, 0))
            self.assertEqual(probe.call_count, 4)
            self.assertTrue(all(approved_camera(item) for item in result['found']))

    def test_dead_addresses_are_skipped_during_backoff_and_recover_on_success(self):
        scanner, clock = self.scanner()
        with patch.object(scanner, '_probe', return_value=None) as probe, patch('discovery.discover_names', return_value={}):
            self.scan(scanner)
            clock.advance(10)
            self.assertEqual(self.scan(scanner)['cached'], 2)
            self.assertEqual(probe.call_count, 2)
            clock.advance(10)
            self.scan(scanner)
            self.assertEqual(probe.call_count, 4)
            clock.advance(10)
            self.assertEqual(self.scan(scanner)['cached'], 2)
            probe.side_effect = self.printer
            clock.advance(20)
            recovered = self.scan(scanner)
            self.assertEqual(len(recovered['found']), 1)
            self.assertEqual(scanner.cache.entries[KEY].failures, 0)

    def test_cached_printers_cannot_bypass_a_changed_approval_policy(self):
        scanner, _clock = self.scanner()
        scanner.cache.put(KEY, PRINTER, 0)
        with patch('discovery.approved_camera', return_value=False), patch.object(scanner, '_probe', return_value=None) as probe, \
                patch('discovery.discover_names', return_value={}):
            result = self.scan(scanner)
        self.assertFalse(result['found'])
        self.assertEqual(probe.call_count, 2)

    def test_known_ips_are_scheduled_first_and_priority_hints_never_expand_the_lan(self):
        scanner, _clock = self.scanner('192.168.50.0/29')
        scanner.prioritize(['192.168.50.6', '8.8.8.8', 'printer.example'])
        targets = scanner._targets()
        self.assertEqual([item[0] for item in targets[:2]], ['192.168.50.6'] * 2)
        self.assertNotIn('8.8.8.8', {item[0] for item in targets})
        self.assertNotIn('printer.example', {item[0] for item in targets})

    def test_overlapping_subnets_have_deduplicated_work_and_correct_percentages(self):
        scanner, _clock = self.scanner('192.168.50.0/30,192.168.50.2/32')
        with patch.object(scanner, '_probe', return_value=None) as probe, patch('discovery.discover_names', return_value={}):
            result = self.scan(scanner)
        self.assertEqual(result['checked'], 4)
        self.assertEqual(result['total'], 4)
        self.assertEqual(probe.call_count, 4)

    def test_fatal_scan_errors_use_exponential_backoff_without_background_retries(self):
        scanner, clock = self.scanner()
        with patch.object(scanner, '_probe', return_value=None), patch('discovery.discover_names', side_effect=OSError('fixture failure')) as names:
            for delay in [10, 20, 40, 80, 120, 120]:
                result = self.scan(scanner)
                self.assertEqual(result['state'], 'error')
                self.assertEqual(scanner.retry_after(), delay)
                clock.advance(delay - 1)
                self.assertFalse(scanner.start())
                clock.advance(1)
            self.assertEqual(names.call_count, 6)
        with patch.object(scanner, '_probe', return_value=None), patch('discovery.discover_names', return_value={}):
            self.assertEqual(self.scan(scanner)['state'], 'done')
        self.assertEqual(scanner.scan_failures, 0)
        self.assertEqual(scanner.retry_after(), 10)

    def test_finished_scan_status_does_not_change_on_every_sse_snapshot(self):
        scanner, clock = self.scanner()
        with patch.object(scanner, '_probe', return_value=None), patch('discovery.discover_names', return_value={}):
            before = self.scan(scanner)
        clock.advance(1)
        self.assertEqual(scanner.status(), before)

    def test_name_lookup_cache_including_empty_results_expires_without_sliding_on_access(self):
        scanner, clock = self.scanner()
        with patch.object(scanner, '_probe', return_value=None), patch('discovery.discover_names', return_value={}) as names:
            self.scan(scanner)
            clock.advance(10)
            self.assertTrue(self.scan(scanner)['names_cached'])
            clock.advance(10)
            self.assertFalse(self.scan(scanner)['names_cached'])
            self.assertEqual(names.call_count, 2)

    def test_probe_parallelism_is_increased_but_still_bounded(self):
        scanner, _clock = self.scanner('192.168.50.0/26')
        ready, release = threading.Event(), threading.Event()
        lock = threading.Lock()
        active = maximum = 0

        def probe(*_args):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
                if active == scanner.PROBE_WORKERS:
                    ready.set()
            release.wait(3)
            with lock:
                active -= 1
            return None

        with patch.object(scanner, '_probe', side_effect=probe), patch('discovery.discover_names', return_value={}):
            self.assertTrue(scanner.start())
            try:
                self.assertTrue(ready.wait(2))
                self.assertEqual(maximum, 48)
                self.assertFalse(scanner.start(), 'Concurrent callers must share one scan.')
            finally:
                release.set()
                scanner.thread.join(3)
        self.assertEqual(scanner.status()['checked'], scanner.status()['total'])

    def test_next_scan_cannot_replace_an_identity_pool_that_is_still_closing(self):
        scanner, clock = self.scanner()
        entered, release = threading.Event(), threading.Event()
        scanner.identifier = Mock()

        def close():
            entered.set()
            release.wait(3)

        scanner.identifier.close.side_effect = close
        with patch.object(scanner, '_probe', return_value=None), patch('discovery.discover_names', return_value={}):
            self.assertTrue(scanner.start())
            try:
                self.assertTrue(entered.wait(2))
                clock.advance(10)
                self.assertEqual(scanner.status()['state'], 'done')
                self.assertFalse(scanner.start())
            finally:
                release.set()
                scanner.thread.join(3)

    def test_closed_scanners_cannot_restart_or_poison_the_cache_with_unfinished_probes(self):
        scanner, clock = self.scanner()
        scanner.close()
        clock.advance(1000)
        self.assertFalse(scanner.start())
        self.assertFalse(scanner.cache.entries)
