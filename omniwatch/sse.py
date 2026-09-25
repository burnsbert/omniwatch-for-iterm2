"""Server-sent events hub (docs/DESIGN.md §4.4.2, docs/SHELL_CONTRACT.md §5).

- Each connected client gets a bounded queue (256). A client that falls
  behind is dropped: its stream ends, it reconnects, and it gets a full
  state again (backpressure without unbounded memory).
- Every message is ``id: <seq>`` / ``event: <type>`` / ``data: <json>``;
  a ``: ping`` comment goes out after each heartbeat interval (15 s) of
  silence so the shell's 45 s idle timeout never fires.
- On connect — including a reconnect with ``Last-Event-ID`` or the
  ``?last_event_id=`` query parameter — the stream always starts with
  ``hello`` and then a full ``state``; no gap replay is needed or done.
- ``subscribe()`` registers the client and captures the state document
  under the same lock the engine holds while publishing, so an event is
  either already reflected in that state or queued after it — never lost
  and never duplicated.
"""
import json
import queue
import threading

QUEUE_SIZE = 256
HEARTBEAT_SECONDS = 15.0
PING = b': ping\n\n'


def encode(seq, event, data):
    """One SSE message. JSON never contains a raw newline, so one data line."""
    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    return ('id: %d\nevent: %s\ndata: %s\n\n' % (seq, event, payload)).encode('utf-8')


def parse_last_event_id(header_value, query_value):
    """The client's last seen id from the header or the query parameter
    (EventSource can't set headers). Returns an int or None."""
    for raw in (header_value, query_value):
        if raw is None:
            continue
        try:
            return int(str(raw).strip())
        except ValueError:
            continue
    return None


class Client:
    __slots__ = ('queue', 'dropped', 'last_event_id')

    def __init__(self, maxsize, last_event_id=None):
        self.queue = queue.Queue(maxsize=maxsize)
        self.dropped = False
        self.last_event_id = last_event_id


class Hub:
    def __init__(self, maxsize=QUEUE_SIZE, heartbeat=HEARTBEAT_SECONDS):
        self.maxsize = maxsize
        self.heartbeat = heartbeat
        # Re-entrant: the engine holds it across a whole publish (several
        # broadcasts) and subscribe() calls back into the engine under it.
        self.lock = threading.RLock()
        self._clients = []
        self.closed = False

    @property
    def client_count(self):
        with self.lock:
            return len(self._clients)

    def subscribe(self, snapshot=None, last_event_id=None):
        """Register a client. Returns ``(client, snapshot())``, both taken
        atomically with respect to broadcasts."""
        client = Client(self.maxsize, last_event_id)
        with self.lock:
            if self.closed:
                client.dropped = True
            else:
                self._clients.append(client)
            snap = snapshot() if snapshot else None
        return client, snap

    def unsubscribe(self, client):
        with self.lock:
            if client in self._clients:
                self._clients.remove(client)

    def broadcast(self, seq, event, data):
        """Queue one event for every client. Call with or without the lock."""
        msg = encode(seq, event, data)
        with self.lock:
            for client in list(self._clients):
                try:
                    client.queue.put_nowait(msg)
                except queue.Full:
                    client.dropped = True
                    self._clients.remove(client)

    def close(self):
        """End every stream (server shutdown)."""
        with self.lock:
            self.closed = True
            clients, self._clients = self._clients, []
        for client in clients:
            client.dropped = True
            try:
                client.queue.put_nowait(None)
            except queue.Full:
                pass

    def stream(self, client, write, first=()):
        """Write `first` messages, then queued events and heartbeats, until
        the client is dropped, the hub closes, or `write` raises (the
        socket went away). Always unsubscribes on the way out."""
        try:
            for msg in first:
                write(msg)
            while not client.dropped and not self.closed:
                try:
                    msg = client.queue.get(timeout=self.heartbeat)
                except queue.Empty:
                    write(PING)
                    continue
                if msg is None:
                    break
                write(msg)
        except (OSError, ValueError):
            pass  # broken pipe / reset / closed file
        finally:
            self.unsubscribe(client)
