"""New (docs/DESIGN.md §4.4.2): SSE framing, heartbeat, backpressure, and
the subscribe/broadcast atomicity the "no gap" contract relies on."""
import json
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase
from _engine_harness import decode

from omniwatch import sse


class TestFraming(TripwireTestCase):
    def test_encode(self):
        msg = sse.encode(7, 'screens', {'text': 'a\nb', 'glyph': '◉'})
        text = msg.decode('utf-8')
        self.assertTrue(text.startswith('id: 7\nevent: screens\ndata: '))
        self.assertTrue(text.endswith('\n\n'))
        self.assertEqual(text.count('\n'), 4)        # newline in data stays escaped
        self.assertIn('◉', text)
        self.assertEqual(decode(msg), (7, 'screens', {'text': 'a\nb', 'glyph': '◉'}))

    def test_parse_last_event_id(self):
        self.assertEqual(sse.parse_last_event_id('12', None), 12)
        self.assertEqual(sse.parse_last_event_id(None, '9'), 9)
        self.assertEqual(sse.parse_last_event_id('x', '4'), 4)
        self.assertEqual(sse.parse_last_event_id(' 5 ', '4'), 5)
        self.assertIsNone(sse.parse_last_event_id(None, None))
        self.assertIsNone(sse.parse_last_event_id('x', 'y'))


class TestHub(TripwireTestCase):
    def test_broadcast_reaches_every_client(self):
        hub = sse.Hub()
        a, _ = hub.subscribe()
        b, snap = hub.subscribe(lambda: 'snapshot')
        self.assertEqual(snap, 'snapshot')
        self.assertEqual(hub.client_count, 2)
        hub.broadcast(1, 'toast', {'m': 1})
        self.assertEqual(decode(a.queue.get_nowait())[1], 'toast')
        self.assertEqual(decode(b.queue.get_nowait())[1], 'toast')
        hub.unsubscribe(a)
        hub.unsubscribe(a)
        self.assertEqual(hub.client_count, 1)

    def test_slow_client_dropped_at_bound(self):
        hub = sse.Hub(maxsize=3)
        slow, _ = hub.subscribe()
        for i in range(3):
            hub.broadcast(i, 'x', {})
        self.assertFalse(slow.dropped)
        hub.broadcast(3, 'x', {})
        self.assertTrue(slow.dropped)
        self.assertEqual(hub.client_count, 0)

    def test_stream_writes_first_then_events_then_ping(self):
        hub = sse.Hub(heartbeat=0.05)
        client, _ = hub.subscribe()
        out = []
        pings = threading.Event()

        def write(data):
            out.append(data)
            if data == sse.PING:
                if pings.is_set():
                    client.dropped = True    # end the stream after two pings
                pings.set()
        hub.broadcast(5, 'toast', {'m': 'hi'})
        hub.stream(client, write, first=[b'first'])
        self.assertEqual(out[0], b'first')
        self.assertEqual(decode(out[1])[:2], (5, 'toast'))
        self.assertEqual(out[2:], [sse.PING, sse.PING])
        self.assertEqual(hub.client_count, 0)

    def test_stream_ends_on_write_error(self):
        hub = sse.Hub()
        client, _ = hub.subscribe()

        def write(data):
            raise BrokenPipeError()
        hub.stream(client, write, first=[b'x'])
        self.assertEqual(hub.client_count, 0)

    def test_close_ends_streams_and_rejects_new(self):
        hub = sse.Hub(heartbeat=5)
        client, _ = hub.subscribe()
        full, _ = hub.subscribe()
        for _ in range(hub.maxsize):
            full.queue.put_nowait(b'x')
        done = threading.Event()
        t = threading.Thread(target=lambda: (hub.stream(client, lambda d: None), done.set()))
        t.start()
        hub.close()
        self.assertTrue(done.wait(2))
        late, _ = hub.subscribe()
        self.assertTrue(late.dropped)
        self.assertEqual(hub.client_count, 0)

    def test_subscribe_is_atomic_with_broadcast(self):
        """An event broadcast while a snapshot is taken is either in the
        snapshot or in the queue — never both, never neither."""
        hub = sse.Hub()
        state = {'seq': 0}

        def publisher():
            for _ in range(200):
                with hub.lock:
                    state['seq'] += 1
                    hub.broadcast(state['seq'], 'x', {})
        t = threading.Thread(target=publisher)
        t.start()
        clients = [hub.subscribe(lambda: state['seq']) for _ in range(50)]
        t.join()
        for client, snap_seq in clients:
            seqs = []
            while not client.queue.empty():
                seqs.append(decode(client.queue.get_nowait())[0])
            self.assertEqual(seqs, list(range(snap_seq + 1, 201)))


if __name__ == '__main__':
    unittest.main()
