"""Temporary camera history retained only for leased, open browser pages."""

from collections import OrderedDict, deque
from contextlib import ExitStack
from dataclasses import dataclass, field
from datetime import datetime
import logging
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
import uuid
import json
import zlib

from providers.telemetry import public_stats


LOG = logging.getLogger('printer-camera')


class PreviewBusy(Exception):
    """The bounded thumbnail workers are busy; playback has priority."""


@dataclass
class PreviewJob:
    done: threading.Event = field(default_factory=threading.Event)
    data: bytes | None = None


@dataclass
class Fragment:
    sequence: int
    start: float
    duration: float
    file: Path
    size: int
    discontinuity: bool = False
    discontinuities: int = 0
    date: str | None = None
    created: float = field(default_factory=time.monotonic)


@dataclass
class Archive:
    camera: str
    directory: Path
    kind: str
    fragments: deque = field(default_factory=deque)
    seen: set = field(default_factory=set)
    generation: str | None = None
    sequence: int = 0
    position: float = 0
    target_duration: int = 2
    discontinuities: int = 0
    pending_discontinuity: bool = False
    primed: bool = False
    last_jpeg_at: float | None = None
    error: str | None = None
    clocks: deque = field(default_factory=deque)
    printer_samples: deque = field(default_factory=deque)
    printer_sequence: int = 0
    printer_polled: float = float('-inf')
    printer_bytes: int = 0


@dataclass
class Session:
    id: str
    camera: str
    first: int
    origin: float
    opened_at: float = field(default_factory=time.time)
    touched: float = field(default_factory=time.monotonic)


class ReplayBuffer:
    PRINTER_LIMIT = 43200  # Twelve hours at 1 Hz; independently bounds metadata memory.
    PRINTER_BYTE_LIMIT = 32 * 1024 * 1024
    PREVIEW_LIMIT = 128
    PREVIEW_BYTE_LIMIT = 16 * 1024 * 1024
    def __init__(self, registry, root=None, max_bytes=None, timeout=None):
        self.registry = registry
        self.root = Path(root or os.environ.get('REPLAY_BUFFER_DIR', '/buffer')) / 'sessions'
        self.max_bytes = max_bytes if max_bytes is not None else int(os.environ.get('REPLAY_MAX_MB', '8192')) * 1024 * 1024
        self.timeout = timeout if timeout is not None else int(os.environ.get('REPLAY_SESSION_TIMEOUT_SECONDS', '1800'))
        if self.max_bytes <= 0 or not 10 <= self.timeout <= 86400:
            raise ValueError('Replay storage must be positive and its session timeout must be 10–86400 seconds.')
        self.lock = threading.RLock()
        self.archives = {}
        self.sessions = {}
        self.previews = OrderedDict()
        self.preview_jobs = {}
        self.preview_workers = threading.BoundedSemaphore(2)
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name='page-replay', daemon=True)

    def start(self):
        # This dedicated directory contains temporary video only, never settings.
        shutil.rmtree(self.root, ignore_errors=True)
        self.root.mkdir(parents=True, exist_ok=True)
        self.thread.start()

    def close(self):
        self.stop_event.set()
        if self.thread.is_alive():
            self.thread.join(timeout=5)
        with self.lock:
            self.sessions.clear()
            self._prune()

    def create(self, camera):
        relay = self.registry.get_relay(camera)
        if not relay:
            raise ValueError('Choose a configured printer first.')
        with self.lock:
            self._prune()
            if len(self.sessions) >= 128:
                raise ValueError('Too many open viewers. Close an unused page and try again.')
            archive = self.archives.get(camera)
            if not archive:
                directory = self.root / uuid.uuid4().hex
                directory.mkdir(parents=True)
                archive = Archive(camera, directory, 'jpeg' if hasattr(relay, 'frame') else 'hls')
                self.archives[camera] = archive
            session = Session(uuid.uuid4().hex, camera, archive.sequence, archive.position, opened_at=time.time())
            self.sessions[session.id] = session
            self._collect_printer(archive, force=True)
            self._collect(archive, relay)
            return self._metadata(session)

    def release(self, token):
        with self.lock:
            self.sessions.pop(token, None)
            self._prune()

    def forget(self, camera):
        with self.lock:
            self.sessions = {token: session for token, session in self.sessions.items() if session.camera != camera}
            self._prune()

    def _session(self, token):
        session = self.sessions.get(token)
        if not session or time.monotonic() - session.touched > self.timeout:
            return None
        session.touched = time.monotonic()
        return session

    def status(self, token):
        with self.lock:
            session = self._session(token)
            return self._metadata(session) if session else None

    def _metadata(self, session):
        archive = self.archives[session.camera]
        first = next((item for item in archive.fragments if item.sequence >= session.first), None)
        clocks = self._clocks(archive, first.start if first else session.origin)
        return {'session_id': session.id, 'camera_id': session.camera, 'kind': archive.kind,
                'playlist_url': f'/replay/{session.id}/live.m3u8' if archive.kind == 'hls' else None,
                'video_url': f'/replay/{session.id}/video' if archive.kind == 'hls' else None,
                'frame_url': f'/replay/{session.id}/frame.jpg' if archive.kind == 'jpeg' else None,
                'start_seconds': round(max(0, first.start - session.origin), 3) if first else 0,
                'end_seconds': round(max(0, archive.position - session.origin), 3),
                'clock': [{'position': round(position - session.origin, 3), 'time': epoch}
                          for position, epoch in clocks],
                'end_time': (archive.last_jpeg_at if archive.kind == 'jpeg' else
                             clocks[-1][1] + archive.position - clocks[-1][0] if clocks else None),
                'ready': first is not None, 'limited': bool(first and first.sequence > session.first),
                'error': archive.error}

    @staticmethod
    def _clocks(archive, position):
        clocks = list(archive.clocks)
        before = [item for item in clocks if item[0] <= position]
        return before[-1:] + [item for item in clocks if item[0] > position]

    def _collect_printer(self, archive, force=False):
        now = time.monotonic()
        if not force and now - archive.printer_polled < 1:
            return
        archive.printer_polled = now
        factory = getattr(self.registry, 'get_telemetry', None)
        client = factory(archive.camera) if factory else None
        if not client:
            return
        status = client.status()
        if not isinstance(status, dict):
            return
        # Manufacturer fields can be nested and numerous. Compress each private
        # snapshot so expanded diagnostics do not retain thousands of Python
        # objects per recorded second. HTTP/SSE still sends ordinary JSON.
        values = public_stats(status)
        encoded = zlib.compress(json.dumps(values, separators=(',', ':'), allow_nan=False).encode(), level=1)
        epoch = round(time.time(), 3)
        if archive.printer_samples:
            epoch = max(epoch, archive.printer_samples[-1]['at'] + 0.001)
        archive.printer_samples.append({'id': archive.printer_sequence, 'at': epoch, 'printer': encoded})
        archive.printer_bytes += len(encoded) + 256
        archive.printer_sequence += 1
        while len(archive.printer_samples) > 1 and (len(archive.printer_samples) > self.PRINTER_LIMIT or
                                                  archive.printer_bytes > self.PRINTER_BYTE_LIMIT):
            self._drop_printer_sample(archive)

    @staticmethod
    def _drop_printer_sample(archive):
        archive.printer_bytes -= len(archive.printer_samples.popleft()['printer']) + 256

    def _printer_samples(self, session):
        archive = self.archives[session.camera]
        # A later tab cannot read readings recorded before that tab opened.
        return archive, (sample for sample in archive.printer_samples if sample['at'] >= session.opened_at)

    def printer_updates(self, token, after=None):
        """Small initial history, then deltas on the existing metadata stream."""
        with self.lock:
            session = self._session(token)
            if not session:
                return None
            archive = self.archives[session.camera]
            selected = []
            for sample in reversed(archive.printer_samples):
                if sample['at'] < session.opened_at:
                    break
                selected.append(sample)
                if (after is None and len(selected) >= 32) or (after is not None and sample['id'] <= after):
                    break
            if not selected:
                return None
            selected.reverse()
            return self._printer_payload(session, selected, selected[0]['at'], selected[-1]['at'])

    @staticmethod
    def _printer_payload(session, samples, start, end):
        return {'session_id': session.id, 'camera_id': session.camera,
                'from': start, 'until': end, 'cursor': samples[-1]['id'] if samples else None,
                'samples': [{'at': sample['at'], 'printer': json.loads(zlib.decompress(sample['printer']))} for sample in samples]}

    def printer_history(self, token, at):
        """One two-minute window on an explicit seek, never a polling endpoint."""
        with self.lock:
            session = self._session(token)
            if not session:
                return None
            archive, available = self._printer_samples(session)
            start = math.floor(at / 120) * 120
            end = start + 120
            samples = []
            baseline = None
            for sample in available:
                if sample['at'] < start:
                    baseline = sample
                elif sample['at'] <= end:
                    samples.append(sample)
                else:
                    break
            if baseline:
                samples.insert(0, baseline)
            until = min(end, archive.printer_samples[-1]['at']) if archive.printer_samples else end
            return self._printer_payload(session, samples, start, max(start, until))

    def video_update(self, token, after=None, sequence=None):
        """An incremental index and one media file, restricted to this page.

        Copy descriptors under the archive lock, then do socket/file IO outside
        it. A slow viewer must never block recording or another viewer.
        """
        with self.lock:
            session = self._session(token)
            if not session:
                return None
            archive = self.archives[session.camera]
            if archive.kind != 'hls':
                return None
            fragments = [item for item in archive.fragments if item.sequence >= session.first]
            index = {'type': 'index' if after is None else 'update',
                     'first': session.first,
                     'start': fragments[0].sequence if fragments else archive.sequence,
                     'last': archive.sequence - 1, 'target': archive.target_duration,
                     'segments': [{'sequence': item.sequence, 'duration': item.duration,
                                   'discontinuity': item.discontinuity,
                                   'discontinuities': item.discontinuities, 'date': item.date}
                                  for item in fragments if after is None or item.sequence > after]}
            # Refresh/reconnect starts near Live unless the decoder requests a
            # particular archived segment. Never send history from another tab.
            if sequence is None:
                item = fragments[max(0, len(fragments) - 6)] if fragments else None
            else:
                item = next((item for item in fragments if item.sequence >= sequence), None)
            return index, item

    def playlist(self, token):
        with self.lock:
            session = self._session(token)
            if not session:
                return None
            archive = self.archives[session.camera]
            if archive.kind != 'hls':
                return None
            fragments = [item for item in archive.fragments if item.sequence >= session.first]
            if not fragments:
                return b''
            first = fragments[0]
            lines = ['#EXTM3U', '#EXT-X-VERSION:3',
                     f'#EXT-X-TARGETDURATION:{archive.target_duration}',
                     f'#EXT-X-MEDIA-SEQUENCE:{first.sequence}',
                     f'#EXT-X-DISCONTINUITY-SEQUENCE:{first.discontinuities - int(first.discontinuity)}']
            # A growing EVENT playlist lets Safari seek back to the page's start.
            # If the storage cap trims it, use a regular sliding live playlist.
            if first.sequence == session.first:
                lines.append('#EXT-X-PLAYLIST-TYPE:EVENT')
            for item in fragments:
                if item.discontinuity:
                    lines.append('#EXT-X-DISCONTINUITY')
                if item.date:
                    lines.append('#EXT-X-PROGRAM-DATE-TIME:' + item.date)
                lines.extend([f'#EXTINF:{item.duration:.6f},', f'segment-{item.sequence}.ts'])
            return ('\n'.join(lines) + '\n').encode()

    def media(self, token, sequence=None, at=None):
        with self.lock:
            session = self._session(token)
            if not session:
                return None
            archive = self.archives[session.camera]
            selected = None
            for item in archive.fragments:
                if item.sequence < session.first:
                    continue
                if at is not None:
                    if selected is not None and item.start - session.origin > at:
                        break
                    selected = item
                elif item.sequence == sequence:
                    selected = item
                    break
            return selected.file if selected else None

    def preview(self, token, at, frames=1):
        """A 3 x 2 sprite of five-second stills from this page's history.

        Open files under the lock so trimming cannot remove them mid-read,
        then decode outside it. At most six single-frame inputs per job, two
        workers and a shared 16 MiB LRU keep playback ahead of preview work.
        """
        if not math.isfinite(at) or at < 0 or type(frames) is not int or not 1 <= frames <= 6:
            return None
        with self.lock:
            session = self._session(token)
            if not session:
                return None
            archive = self.archives[session.camera]
            retained = [item for item in archive.fragments if item.sequence >= session.first]
            if not retained:
                return None
            samples = []
            for index in range(frames):
                position = session.origin + at + index * 5
                # Public session bounds are rounded to milliseconds.
                if retained[0].start - 0.001 <= position < retained[0].start:
                    position = retained[0].start
                item = next((item for item in retained if item.start <= position < item.start + item.duration), None)
                if not item:
                    return None
                # Leave room for a decoded frame before the end of a fragment;
                # one near-EOF sample must not make the entire sheet empty.
                offset = 0 if archive.kind == 'jpeg' else min(round(position - item.start, 3), max(0, item.duration - 0.1))
                samples.append((item, offset))
            key = (session.camera, archive.directory.name, tuple((item.sequence, offset) for item, offset in samples))
            if key in self.previews:
                self.previews.move_to_end(key)
                return self.previews[key]
            job = self.preview_jobs.get(key)
            if job:
                sources = None
            else:
                if not self.preview_workers.acquire(blocking=False):
                    raise PreviewBusy
                sources = []
                try:
                    for item, offset in samples:
                        sources.append((item.file.open('rb'), offset))
                except OSError:
                    for source, _ in sources:
                        source.close()
                    self.preview_workers.release()
                    return None
                job = PreviewJob()
                self.preview_jobs[key] = job
        if sources is None:
            if not job.done.wait(6):
                raise PreviewBusy
            with self.lock:
                return job.data if self._session(token) and key in self.previews else None
        try:
            with ExitStack() as opened:
                for source, _ in sources:
                    opened.enter_context(source)
                data = self._sprite(sources)
            with self.lock:
                # A forgotten printer or trimmed fragment must not be resurrected
                # by work that was already running when its buffer was removed.
                if (data and self.archives.get(session.camera) is archive and archive.fragments and
                        archive.fragments[0].sequence <= samples[0][0].sequence):
                    self.previews[key] = data
                    while (len(self.previews) > self.PREVIEW_LIMIT or
                           sum(len(value) for value in self.previews.values()) > self.PREVIEW_BYTE_LIMIT):
                        self.previews.popitem(last=False)
                    job.data = data
                    return data if self._session(token) else None
            return None
        finally:
            with self.lock:
                self.preview_jobs.pop(key, None)
                job.done.set()
            self.preview_workers.release()

    @staticmethod
    def _sprite(sources):
        # Seekable inherited descriptors survive concurrent retention trimming.
        # One FFmpeg invocation returns a fixed-size sheet, including black cells
        # for footage that did not exist when a partial sheet was requested.
        try:
            command = ['ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'error', '-filter_complex_threads', '1']
            filters = []
            for index, (source, offset) in enumerate(sources):
                command.extend(['-threads', '1', '-i', f'/proc/self/fd/{source.fileno()}'])
                # Short TS fragments often contain only one keyframe, so input
                # seeking skips it. Decode from that keyframe and trim locally;
                # reset their absolute stream timestamps before selecting time.
                filters.append(f'[{index}:v:0]setpts=PTS-STARTPTS,trim=start={offset},trim=end_frame=1,setpts=PTS-STARTPTS,'
                               'scale=320:180:force_original_aspect_ratio=decrease:force_divisible_by=2,'
                               f'pad=320:180:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[cell{index}]')
            if len(sources) > 1:
                inputs = ''.join(f'[cell{index}]' for index in range(len(sources)))
                layout = '|'.join(f'{index % 3 * 320}_{index // 3 * 180}' for index in range(len(sources)))
                filters.append(f'{inputs}xstack=inputs={len(sources)}:layout={layout}:fill=black:shortest=1[grid]')
                grid = '[grid]'
            else:
                grid = '[cell0]'
            filters.append(f'{grid}pad=960:360:0:0[sheet]')
            command.extend(['-filter_complex', ';'.join(filters), '-map', '[sheet]', '-frames:v', '1', '-an', '-sn',
                            '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-q:v', '5', '-threads', '1', '-f', 'image2pipe', 'pipe:1'])
            result = subprocess.run(
                command, pass_fds=tuple(source.fileno() for source, _ in sources),
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
            if result.returncode == 0 and result.stdout.startswith(b'\xff\xd8') and len(result.stdout) <= 512 * 1024:
                return result.stdout
        except (OSError, subprocess.TimeoutExpired):
            pass
        return None

    @staticmethod
    def _segments(directory):
        text = (directory / 'live.m3u8').read_text()
        duration = None
        date = None
        target = 2
        items = []
        for line in text.splitlines():
            if line.startswith('#EXT-X-TARGETDURATION:'):
                target = int(line.split(':', 1)[1])
            elif line.startswith('#EXTINF:'):
                duration = float(line.split(':', 1)[1].split(',')[0])
            elif line.startswith('#EXT-X-PROGRAM-DATE-TIME:'):
                date = line.split(':', 1)[1]
            elif re.fullmatch(r'segment-[0-9]+\.ts', line) and duration is not None:
                if math.isfinite(duration) and 0 < duration <= 600:
                    items.append((line, duration, date))
                duration = None
                date = None
        return target, items

    def _collect(self, archive, relay):
        if archive.kind == 'jpeg':
            with relay.lock:
                frame = relay.frame if relay.state == 'live' else None
                timestamp = relay.last_segment_at
            if frame and timestamp != archive.last_jpeg_at:
                duration = max(0.1, timestamp - archive.last_jpeg_at) if archive.last_jpeg_at else 1
                path = archive.directory / f'frame-{archive.sequence}.jpg'
                path.write_bytes(frame)
                self._append(archive, path, duration, epoch=timestamp)
                archive.last_jpeg_at = timestamp
                archive.error = None
            return
        with relay.lock:
            directory = relay.directory
            generation = relay.generation
        if not directory:
            return
        try:
            target, items = self._segments(directory)
        except FileNotFoundError:
            return
        if not items:
            return
        archive.target_duration = max(archive.target_duration, target)
        if archive.generation is not None and archive.generation != generation:
            archive.pending_discontinuity = True
        if archive.generation != generation:
            archive.seen.clear()
            archive.generation = generation
        if not archive.primed:
            # Do not import the rolling live window from before this page opened.
            archive.seen.update(item[0] for item in items[:-1])
            archive.primed = True
        for name, duration, date in items:
            if name in archive.seen:
                continue
            path = archive.directory / f'segment-{archive.sequence}.ts'
            try:
                shutil.copyfile(directory / name, path)
            except FileNotFoundError:
                path.unlink(missing_ok=True)
                continue
            self._append(archive, path, duration, archive.pending_discontinuity, date)
            archive.seen.add(name)
            archive.pending_discontinuity = False
            archive.error = None

    @staticmethod
    def _append(archive, path, duration, discontinuity=False, date=None, epoch=None):
        if date:
            try:
                epoch = datetime.fromisoformat(date.replace('Z', '+00:00')).timestamp()
            except (ValueError, OverflowError):
                pass
        if epoch is None:
            epoch = time.time() - duration
        if (not archive.clocks or discontinuity or
                abs(epoch - (archive.clocks[-1][1] + archive.position - archive.clocks[-1][0])) > 0.25):
            archive.clocks.append((archive.position, epoch))
        if discontinuity:
            archive.discontinuities += 1
        archive.fragments.append(Fragment(archive.sequence, archive.position, duration,
                                         path, path.stat().st_size, discontinuity,
                                         archive.discontinuities, date))
        archive.sequence += 1
        archive.position += duration

    def _prune(self):
        now = time.monotonic()
        for token, session in list(self.sessions.items()):
            if now - session.touched > self.timeout:
                del self.sessions[token]
        for camera, archive in list(self.archives.items()):
            active = [session.first for session in self.sessions.values() if session.camera == camera]
            if not active:
                shutil.rmtree(archive.directory, ignore_errors=True)
                del self.archives[camera]
                continue
            while archive.fragments and archive.fragments[0].sequence < min(active):
                archive.fragments.popleft().file.unlink(missing_ok=True)
        total = sum(item.size for archive in self.archives.values() for item in archive.fragments)
        while total > self.max_bytes:
            candidates = [archive for archive in self.archives.values() if len(archive.fragments) > 1]
            if not candidates:
                break
            archive = min(candidates, key=lambda item: item.fragments[0].created)
            item = archive.fragments.popleft()
            item.file.unlink(missing_ok=True)
            total -= item.size
        for archive in self.archives.values():
            if not archive.fragments:
                continue
            first = archive.fragments[0].start
            while len(archive.clocks) > 1 and archive.clocks[1][0] <= first:
                archive.clocks.popleft()
            if archive.clocks:
                retained_time = archive.clocks[0][1] + first - archive.clocks[0][0]
                while len(archive.printer_samples) > 1 and archive.printer_samples[1]['at'] <= retained_time:
                    self._drop_printer_sample(archive)
        for key in list(self.previews):
            archive = self.archives.get(key[0])
            if (not archive or archive.directory.name != key[1] or not archive.fragments or
                    not archive.fragments[0].sequence <= key[2][0][0] <= key[2][-1][0] <= archive.fragments[-1].sequence):
                del self.previews[key]

    def _run(self):
        while not self.stop_event.wait(0.5):
            with self.lock:
                for camera, archive in list(self.archives.items()):
                    relay = self.registry.get_relay(camera)
                    if relay:
                        try:
                            self._collect_printer(archive)
                            self._collect(archive, relay)
                        except (OSError, ValueError):
                            archive.error = 'The rewind buffer is temporarily unavailable.'
                            LOG.warning('Could not update temporary camera history.')
                self._prune()
