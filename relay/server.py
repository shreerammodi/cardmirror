"""CardMirror card-sharing relay — standalone, self-hostable.

A content-agnostic store-and-forward mailbox with live push:

  POST   /relay/messages              store one addressed (encrypted) bundle
  GET    /relay/messages?recipient=   pull everything addressed to a code
  GET    /relay/stream?recipient=     SSE push: live-delivers new bundles
  DELETE /relay/messages/{msg_id}     acknowledge / remove one delivered bundle
  GET    /relay/health                liveness (no auth)

…plus durable ROOMS for collaboration sessions (opaque encrypted CRDT
update logs with server-assigned delivery cursors):

  POST   /relay/rooms                       create → {roomId}
  POST   /relay/rooms/{id}/updates          append opaque blob → {seq}
  GET    /relay/rooms/{id}/updates?after=N  snapshot (if N predates it) + tail
  GET    /relay/rooms/{id}/stream           SSE: hello{lastSeq}, update/presence frames
  POST   /relay/rooms/{id}/snapshot         {blob, coversThroughSeq} → truncates ≤ seq
  POST   /relay/rooms/{id}/presence         ephemeral fan-out, never stored
  DELETE /relay/rooms/{id}                  end session (tombstone → 410)

This is the same wire contract CardMirror's official relay speaks, so
pointing the app at your own deployment is just Settings → Card Sharing →
Custom relay URL + Custom relay token. Everyone sharing cards with each
other must use the same relay.

Design notes:
  - Directed addressing: a sender POSTs to the recipient's routing code;
    the recipient receives only its own code and never sends to itself,
    so there is no self-echo.
  - Store-then-push: POST writes the row first (durability), then
    live-pushes to any open /relay/stream connections. Clients catch up
    via GET on every (re)connect, so delivery is at-least-once and the
    client's per-message dedupe absorbs overlap.
  - Messages are swept after 3 hours whether or not they were fetched
    (lazy expiry via a created_at cutoff on reads + a background sweeper).
  - The in-process push registry requires a SINGLE worker process (run
    plain `uvicorn`, no --workers).
  - DB-touching handlers are sync `def` on purpose: Starlette runs them
    in its threadpool, keeping the blocking psycopg2 driver off the
    event loop (which must stay free to serve SSE streams and accept
    connections). The pool is sized to the threadpool; exhaustion sheds
    as 503. Run uvicorn with `--limit-concurrency` sized WELL ABOVE the
    expected number of concurrent SSE streams (it counts long-lived
    connections) — e.g. 4096 — as a connection-storm backstop.

Rooms design notes:
  - `seq` is a delivery cursor, not a semantic order: CRDT updates are
    commutative, so the server only promises "give me everything after
    N" resumption. A global sequence shared across rooms is fine (gaps
    within a room are expected and harmless).
  - Compaction is the CLIENT's job (the server cannot read ciphertext):
    a client periodically uploads an encrypted snapshot covering
    everything through seq S; the server then deletes updates ≤ S.
    Joins fetch snapshot + tail, bounding join time on large docs.
  - Ended sessions tombstone (410, distinct from never-existed 404) so
    clients can tell "session over" from "bad room id". Idle rooms are
    garbage-collected after ROOM_IDLE_GC — generous by design: a
    session legitimately spans a travel day + tournament weekend with
    long fully-offline gaps.
  - At most MAX_STREAMS_PER_ROOM concurrent streams per room (409 on
    the next), which is also the participant ceiling.

PRIVACY: the card payload is end-to-end encrypted by the CardMirror
client. This server stores the bundle OPAQUELY (the `body` column) and
must never log or inspect it — only routing codes, ids, and counts are
ever touched here. Room update/snapshot/presence blobs are equally
opaque ciphertext: store, forward, count — never decode.

Env:
  RELAY_TOKEN    required — the shared bearer your CardMirror clients
                 configure as "Custom relay token".
  DATABASE_URL   required — Postgres, e.g.
                 postgresql://user:pass@localhost:5432/relay
  PORT           optional (default 8000; the Dockerfile wires this up).

See README.md for one-command deployment with docker compose.
"""
import asyncio
import base64
import gzip
import hmac
import json
import logging
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from sqlalchemy import BigInteger, Boolean, Column, DateTime, Index, String, create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import TimeoutError as SATimeoutError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("relay")

# ── Storage ──────────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is required")

# Pool sized to Starlette's sync-handler threadpool (AnyIO default: 40
# tokens) so worker threads never convoy behind connection checkout. A
# short pool_timeout turns exhaustion into a clean 503 (see the
# TimeoutError handler below) instead of an unbounded queue.
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_size=40,
    max_overflow=0,
    pool_timeout=5,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


class RelayMessage(Base):
    __tablename__ = "relay_messages"

    id = Column(String, primary_key=True)
    recipient_code = Column(String, nullable=False)
    body = Column(JSONB, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    __table_args__ = (
        Index("ix_relay_messages_recipient_created", "recipient_code", "created_at"),
    )


class RelayRoom(Base):
    __tablename__ = "relay_rooms"

    id = Column(String, primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_activity = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    bytes_used = Column(BigInteger, default=0, nullable=False)
    tombstoned = Column(Boolean, default=False, nullable=False)


class RelayRoomUpdate(Base):
    __tablename__ = "relay_room_updates"

    # Global autoincrement doubles as the per-room delivery cursor (`seq`).
    # Gaps within a room are expected; clients only rely on "after N".
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    room_id = Column(String, nullable=False)
    blob = Column(String, nullable=False)  # base64 ciphertext, opaque
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("ix_relay_room_updates_room_id_id", "room_id", "id"),
    )


class RelayRoomSnapshot(Base):
    __tablename__ = "relay_room_snapshots"

    room_id = Column(String, primary_key=True)
    blob = Column(String, nullable=False)  # base64 ciphertext, opaque
    covers_through_seq = Column(BigInteger, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Limits / lifecycle ───────────────────────────────────────────────

MAX_BYTES = 25 * 1024 * 1024  # decompressed payload cap
MAX_COMPRESSED_BYTES = 30 * 1024 * 1024  # gzip-bomb guard
TTL = timedelta(hours=3)
MAX_PER_POLL = 100
HEARTBEAT_SECONDS = 25
STREAM_QUEUE_MAX = 100

# Rooms (collaboration sessions)
MAX_UPDATE_BYTES = 5 * 1024 * 1024        # one appended blob (chunked client-side above 256 KiB)
ROOM_CAP_BYTES = 200 * 1024 * 1024        # total stored per room (updates + snapshot)
MAX_UPDATES_PER_PAGE = 200
MAX_STREAMS_PER_ROOM = 10                 # participant ceiling, enforced at stream connect
ROOM_IDLE_GC = timedelta(days=7)          # must exceed travel day + tournament weekend

# routing code → open stream queues (single-worker only; see module doc)
_streams: dict[str, set["asyncio.Queue[dict]"]] = {}

# The server's one event loop, captured at startup. Sync (threadpool)
# handlers must never touch _streams or its asyncio.Queues directly —
# they are loop-owned and not thread-safe. All push fan-out is scheduled
# onto the loop via call_soon_threadsafe(_push_to_streams, …).
_loop: Optional[asyncio.AbstractEventLoop] = None


def _push_to_streams(recipient: str, message: dict) -> None:
    """Runs ON the event loop. A full queue sheds the push — the
    client's next catch-up poll covers it (at-least-once delivery)."""
    queues = _streams.get(recipient)
    if not queues:
        return
    for q in list(queues):
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            pass


# room id → open stream queues (single-worker only, like _streams)
_room_streams: dict[str, set["asyncio.Queue[dict]"]] = {}


def _push_to_room(room_id: str, frame: dict) -> None:
    """Runs ON the event loop; same shed-on-full semantics as
    `_push_to_streams` (a catch-up `GET updates?after=` recovers)."""
    queues = _room_streams.get(room_id)
    if not queues:
        return
    for q in list(queues):
        try:
            q.put_nowait(frame)
        except asyncio.QueueFull:
            pass


def _sweep(db: Session) -> int:
    cutoff = datetime.utcnow() - TTL
    removed = (
        db.query(RelayMessage)
        .filter(RelayMessage.created_at < cutoff)
        .delete(synchronize_session=False)
    )
    # Room GC: idle rooms tombstone (clients see 410 "session ended");
    # tombstones past a second idle period are dropped entirely.
    idle_cutoff = datetime.utcnow() - ROOM_IDLE_GC
    idle = (
        db.query(RelayRoom)
        .filter(RelayRoom.last_activity < idle_cutoff)
        .all()
    )
    for room in idle:
        db.query(RelayRoomUpdate).filter(RelayRoomUpdate.room_id == room.id).delete(
            synchronize_session=False
        )
        db.query(RelayRoomSnapshot).filter(RelayRoomSnapshot.room_id == room.id).delete(
            synchronize_session=False
        )
        if room.tombstoned:
            db.delete(room)
        else:
            room.tombstoned = True
            room.bytes_used = 0
    db.commit()
    return removed


def _sweeper_loop() -> None:
    while True:
        time.sleep(300)
        db = SessionLocal()
        try:
            removed = _sweep(db)
            if removed:
                logger.info("[relay] swept %d expired message(s)", removed)
        except Exception as e:  # never let the sweeper kill the thread
            logger.warning("[relay] sweep error: %s", e)
        finally:
            db.close()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    global _loop
    _loop = asyncio.get_running_loop()
    Base.metadata.create_all(engine)
    threading.Thread(target=_sweeper_loop, daemon=True).start()
    yield


app = FastAPI(title="CardMirror relay", lifespan=_lifespan)


@app.exception_handler(SATimeoutError)
async def _pool_exhausted(_request: Request, _exc: SATimeoutError) -> JSONResponse:
    # Connection-pool checkout timed out: the server is at capacity.
    # Shed with a clean 503 — clients retry (send is user-driven; polls
    # retry next interval; streams reconnect with backoff).
    return JSONResponse({"detail": "relay busy, retry shortly"}, status_code=503)


# ── Auth ─────────────────────────────────────────────────────────────


def require_relay_token(authorization: Optional[str] = Header(None)) -> None:
    """Shared bearer token. This stops the relay being an open public
    service; it is NOT the privacy mechanism (payloads are end-to-end
    encrypted, and the per-recipient routing code is the isolation
    boundary)."""
    expected = os.getenv("RELAY_TOKEN", "")
    if not expected:
        raise HTTPException(500, "RELAY_TOKEN not configured on server")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    if not hmac.compare_digest(authorization[len("Bearer "):], expected):
        raise HTTPException(401, "Invalid relay token")


def _epoch_ms(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


# ── Routes ───────────────────────────────────────────────────────────


@app.get("/relay/health")
def relay_health() -> dict:
    return {"ok": True}


async def _raw_body(request: Request) -> bytes:
    """Reads the request body on the event loop (a sync handler cannot
    await); everything after this runs on a worker thread."""
    return await request.body()


# Deliberately a sync `def`: Starlette runs it in the threadpool, so the
# blocking psycopg2 commit never executes on the event loop. Under
# sustained load the loop previously convoyed and stopped reading new
# connections entirely (permanent accept-path stall at ~200 msg/s,
# CPU idle); threadpool execution + the pool sizing above removes the
# failure mode — overload now degrades to clean 503s instead.
@app.post("/relay/messages", status_code=202, dependencies=[Depends(require_relay_token)])
def post_message(
    raw: bytes = Depends(_raw_body),
    content_encoding: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> JSONResponse:
    if len(raw) > MAX_COMPRESSED_BYTES:
        raise HTTPException(413, "payload too large")

    if "gzip" in (content_encoding or "").lower():
        try:
            data = gzip.decompress(raw)
        except Exception:
            raise HTTPException(400, "invalid gzip body")
    else:
        data = raw

    if len(data) > MAX_BYTES:
        raise HTTPException(413, "payload too large")

    try:
        payload = json.loads(data) if data else {}
    except Exception:
        raise HTTPException(400, "invalid json")

    if not isinstance(payload, dict):
        raise HTTPException(400, "invalid payload")
    recipient = payload.get("recipientCode")
    if not isinstance(recipient, str) or not recipient:
        raise HTTPException(400, "missing recipientCode")

    msg_id = uuid.uuid4().hex
    row = RelayMessage(id=msg_id, recipient_code=recipient, body=payload)
    db.add(row)
    db.commit()
    logger.info("[relay] POST recipient=%s… msgId=%s", recipient[:8], msg_id[:8])

    # Store-then-push. This runs on a worker thread; asyncio.Queues are
    # loop-owned and NOT thread-safe, so the fan-out is scheduled onto
    # the loop rather than touched here.
    if _loop is not None:
        message = {**payload, "msgId": msg_id, "receivedAt": _epoch_ms(row.created_at)}
        _loop.call_soon_threadsafe(_push_to_streams, recipient, message)
    return JSONResponse({"msgId": msg_id}, status_code=202)


@app.get("/relay/messages", dependencies=[Depends(require_relay_token)])
def get_messages(
    recipient: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
) -> dict:
    # Lazy expiry via cutoff filter; the sweeper owns actual deletion.
    cutoff = datetime.utcnow() - TTL
    rows = (
        db.query(RelayMessage)
        .filter(
            RelayMessage.recipient_code == recipient,
            RelayMessage.created_at >= cutoff,
        )
        .order_by(RelayMessage.created_at.asc())
        .limit(MAX_PER_POLL)
        .all()
    )
    messages = [
        {**row.body, "msgId": row.id, "receivedAt": _epoch_ms(row.created_at)}
        for row in rows
    ]
    return {"messages": messages}


@app.get("/relay/stream", dependencies=[Depends(require_relay_token)])
async def stream_messages(
    request: Request,
    recipient: str = Query(..., min_length=1),
) -> StreamingResponse:
    """SSE push channel: `event: hello` on connect, one `data:` frame per
    newly POSTed bundle, heartbeat comments while idle."""
    queue: "asyncio.Queue[dict]" = asyncio.Queue(maxsize=STREAM_QUEUE_MAX)
    _streams.setdefault(recipient, set()).add(queue)

    async def gen() -> AsyncIterator[str]:
        try:
            yield "event: hello\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    return
                try:
                    message = await asyncio.wait_for(
                        queue.get(), timeout=HEARTBEAT_SECONDS
                    )
                    yield f"data: {json.dumps(message, separators=(',', ':'))}\n\n"
                except asyncio.TimeoutError:
                    yield ": hb\n\n"
        finally:
            peers = _streams.get(recipient)
            if peers is not None:
                peers.discard(queue)
                if not peers:
                    _streams.pop(recipient, None)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete(
    "/relay/messages/{msg_id}",
    status_code=204,
    dependencies=[Depends(require_relay_token)],
)
def delete_message(msg_id: str, db: Session = Depends(get_db)) -> Response:
    db.query(RelayMessage).filter(RelayMessage.id == msg_id).delete(
        synchronize_session=False
    )
    db.commit()
    return Response(status_code=204)


# ── Rooms (collaboration sessions) ───────────────────────────────────


def _room_or_error(db: Session, room_id: str) -> RelayRoom:
    room = db.get(RelayRoom, room_id)
    if room is None:
        raise HTTPException(404, "no such room")
    if room.tombstoned:
        raise HTTPException(410, "session ended")
    return room


def _room_last_seq(db: Session, room_id: str) -> int:
    from sqlalchemy import func

    max_id = (
        db.query(func.max(RelayRoomUpdate.id))
        .filter(RelayRoomUpdate.room_id == room_id)
        .scalar()
    )
    if max_id is not None:
        return int(max_id)
    snap = db.get(RelayRoomSnapshot, room_id)
    return int(snap.covers_through_seq) if snap is not None else 0


@app.post("/relay/rooms", status_code=201, dependencies=[Depends(require_relay_token)])
def create_room(db: Session = Depends(get_db)) -> JSONResponse:
    room_id = uuid.uuid4().hex
    db.add(RelayRoom(id=room_id))
    db.commit()
    logger.info("[relay] room created %s…", room_id[:8])
    return JSONResponse({"roomId": room_id}, status_code=201)


@app.post(
    "/relay/rooms/{room_id}/updates",
    status_code=202,
    dependencies=[Depends(require_relay_token)],
)
def post_room_update(
    room_id: str,
    raw: bytes = Depends(_raw_body),
    db: Session = Depends(get_db),
) -> JSONResponse:
    if not raw:
        raise HTTPException(400, "empty update")
    if len(raw) > MAX_UPDATE_BYTES:
        raise HTTPException(413, "update too large")
    room = _room_or_error(db, room_id)
    if room.bytes_used + len(raw) > ROOM_CAP_BYTES:
        raise HTTPException(413, "room storage cap reached")
    b64 = base64.b64encode(raw).decode("ascii")
    row = RelayRoomUpdate(room_id=room_id, blob=b64)
    db.add(row)
    room.bytes_used = room.bytes_used + len(raw)
    room.last_activity = datetime.utcnow()
    db.commit()
    seq = int(row.id)
    if _loop is not None:
        _loop.call_soon_threadsafe(_push_to_room, room_id, {"t": "u", "seq": seq, "blob": b64})
    return JSONResponse({"seq": seq}, status_code=202)


@app.get("/relay/rooms/{room_id}/updates", dependencies=[Depends(require_relay_token)])
def get_room_updates(
    room_id: str,
    after: int = Query(0, ge=0),
    db: Session = Depends(get_db),
) -> dict:
    _room_or_error(db, room_id)
    out: dict = {}
    snap = db.get(RelayRoomSnapshot, room_id)
    floor = after
    if snap is not None and after < snap.covers_through_seq:
        out["snapshot"] = {
            "blob": snap.blob,
            "coversThroughSeq": int(snap.covers_through_seq),
        }
        floor = int(snap.covers_through_seq)
    rows = (
        db.query(RelayRoomUpdate)
        .filter(RelayRoomUpdate.room_id == room_id, RelayRoomUpdate.id > floor)
        .order_by(RelayRoomUpdate.id.asc())
        .limit(MAX_UPDATES_PER_PAGE)
        .all()
    )
    out["updates"] = [{"seq": int(r.id), "blob": r.blob} for r in rows]
    out["more"] = len(rows) == MAX_UPDATES_PER_PAGE
    out["lastSeq"] = int(rows[-1].id) if rows else floor
    return out


@app.post(
    "/relay/rooms/{room_id}/snapshot",
    status_code=204,
    dependencies=[Depends(require_relay_token)],
)
def post_room_snapshot(
    room_id: str,
    raw: bytes = Depends(_raw_body),
    db: Session = Depends(get_db),
) -> Response:
    try:
        payload = json.loads(raw)
        blob = payload["blob"]
        covers = int(payload["coversThroughSeq"])
        if not isinstance(blob, str) or not blob or covers < 0:
            raise ValueError
    except Exception:
        raise HTTPException(400, "expected {blob, coversThroughSeq}")
    if len(blob) > MAX_UPDATE_BYTES * 8:
        raise HTTPException(413, "snapshot too large")
    room = _room_or_error(db, room_id)
    existing = db.get(RelayRoomSnapshot, room_id)
    if existing is not None and covers <= existing.covers_through_seq:
        # Stale or duplicate compaction (another client got there first).
        return Response(status_code=204)
    if existing is None:
        db.add(RelayRoomSnapshot(room_id=room_id, blob=blob, covers_through_seq=covers))
    else:
        existing.blob = blob
        existing.covers_through_seq = covers
        existing.created_at = datetime.utcnow()
    db.query(RelayRoomUpdate).filter(
        RelayRoomUpdate.room_id == room_id, RelayRoomUpdate.id <= covers
    ).delete(synchronize_session=False)
    # Recompute stored size from what actually remains (base64 length is a
    # fine proxy for the cap's purpose).
    from sqlalchemy import func

    remaining = (
        db.query(func.coalesce(func.sum(func.length(RelayRoomUpdate.blob)), 0))
        .filter(RelayRoomUpdate.room_id == room_id)
        .scalar()
    )
    room.bytes_used = int(remaining) + len(blob)
    room.last_activity = datetime.utcnow()
    db.commit()
    return Response(status_code=204)


@app.post(
    "/relay/rooms/{room_id}/presence",
    status_code=202,
    dependencies=[Depends(require_relay_token)],
)
async def post_room_presence(room_id: str, request: Request) -> JSONResponse:
    """Ephemeral fan-out only — never stored, never touches the DB (this
    is the hot path at cursor-move rates). An unknown room simply has no
    open streams, so the frame goes nowhere."""
    raw = await request.body()
    if not raw:
        raise HTTPException(400, "empty presence")
    if len(raw) > 64 * 1024:
        raise HTTPException(413, "presence too large")
    b64 = base64.b64encode(raw).decode("ascii")
    _push_to_room(room_id, {"t": "p", "blob": b64})
    return JSONResponse({}, status_code=202)


@app.get("/relay/rooms/{room_id}/stream", dependencies=[Depends(require_relay_token)])
async def stream_room(
    request: Request,
    room_id: str,
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """SSE: `event: hello` with the current cursor, then update/presence
    frames. The participant cap is enforced here — holding a stream IS
    being in the room."""
    room = db.get(RelayRoom, room_id)
    if room is None:
        raise HTTPException(404, "no such room")
    if room.tombstoned:
        raise HTTPException(410, "session ended")
    open_count = len(_room_streams.get(room_id, set()))
    if open_count >= MAX_STREAMS_PER_ROOM:
        raise HTTPException(409, "room is full")
    last_seq = _room_last_seq(db, room_id)
    room.last_activity = datetime.utcnow()
    db.commit()

    queue: "asyncio.Queue[dict]" = asyncio.Queue(maxsize=STREAM_QUEUE_MAX)
    _room_streams.setdefault(room_id, set()).add(queue)

    async def gen() -> AsyncIterator[str]:
        try:
            yield f'event: hello\ndata: {{"lastSeq":{last_seq}}}\n\n'
            while True:
                if await request.is_disconnected():
                    return
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                    yield f"data: {json.dumps(frame, separators=(',', ':'))}\n\n"
                    if frame.get("t") == "end":
                        return
                except asyncio.TimeoutError:
                    yield ": hb\n\n"
        finally:
            peers = _room_streams.get(room_id)
            if peers is not None:
                peers.discard(queue)
                if not peers:
                    _room_streams.pop(room_id, None)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete(
    "/relay/rooms/{room_id}",
    status_code=204,
    dependencies=[Depends(require_relay_token)],
)
def delete_room(room_id: str, db: Session = Depends(get_db)) -> Response:
    room = db.get(RelayRoom, room_id)
    if room is None:
        raise HTTPException(404, "no such room")
    if not room.tombstoned:
        room.tombstoned = True
        room.bytes_used = 0
        room.last_activity = datetime.utcnow()
        db.query(RelayRoomUpdate).filter(RelayRoomUpdate.room_id == room_id).delete(
            synchronize_session=False
        )
        db.query(RelayRoomSnapshot).filter(RelayRoomSnapshot.room_id == room_id).delete(
            synchronize_session=False
        )
        db.commit()
        if _loop is not None:
            _loop.call_soon_threadsafe(_push_to_room, room_id, {"t": "end"})
    return Response(status_code=204)
