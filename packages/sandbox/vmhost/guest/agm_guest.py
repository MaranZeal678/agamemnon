# Agamemnon — AI-agent write-path guardian
# Copyright (c) 2026 Elamaran Elangovan. All rights reserved.
#
# Proprietary and confidential. No licence is granted to use, copy, modify,
# distribute, or run this software beyond local evaluation of this repository
# as published. See LICENSE at the repository root.
#
# ref: AGMN-BOZW-F6BTKX-X3LAO

"""
The guest agent — runs INSIDE a microVM (the "code server" of the sandbox).

The VM has no network device. Its only channel is one vsock stream to the
host (CID 2, port 5000), which Firecracker hands to vmhost. Over it:

    guest → host   {"t":"ready"}
    host  → guest  {"t":"run","code":...,"context":{...}}
    guest → host   {"t":"sys","id":n,"req":{...}}      a syscall (db / api / agents)
    host  → guest  {"t":"rep","id":n,"ok":true,"value":...}
    guest → host   {"t":"log","level":"log","msg":"..."}
    guest → host   {"t":"done","ok":true,"value":...} | {"t":"done","ok":false,"error":"..."}

Nothing here is trusted by the host: guest code runs as root in the VM and can
rewrite this file or send any frame. The VM boundary is the isolation; the
host parses every frame as hostile. This agent only makes the honest path
convenient (db.select(...) instead of hand-written frames).

Standard library only. `--unix PATH` / `--tcp HOST:PORT` exist for the
test-only local driver; inside a VM the agent always uses vsock.
"""

import json
import socket
import sys
import textwrap
import traceback

HOST_CID = 2  # VMADDR_CID_HOST
PORT = 5000
MAX_FRAME = 1 << 20


class Channel:
    def __init__(self, sock):
        self.sock = sock
        self.rfile = sock.makefile("rb")
        self.next_id = 0

    def send(self, frame):
        data = json.dumps(frame, separators=(",", ":"), default=str).encode() + b"\n"
        if len(data) > MAX_FRAME:
            data = json.dumps({"t": "log", "level": "error", "msg": "frame too large; dropped"}).encode() + b"\n"
        self.sock.sendall(data)

    def recv(self):
        line = self.rfile.readline(MAX_FRAME + 1)
        if not line:
            raise SystemExit("host closed the channel")
        return json.loads(line)

    def call(self, req):
        """A blocking syscall: one request, one reply."""
        self.next_id += 1
        my = self.next_id
        self.send({"t": "sys", "id": my, "req": req})
        while True:
            f = self.recv()
            if f.get("t") == "rep" and f.get("id") == my:
                if not f.get("ok"):
                    raise SyscallError(f.get("error", "syscall failed"))
                return f.get("value")
            if f.get("t") == "kill":
                raise SystemExit("killed by host")


class SyscallError(Exception):
    pass


def surface(ch):
    """The guest-side API: same shape as the QuickJS enclave's db / api / agents."""

    class DB:
        def select(self, table, where=None):
            return ch.call({"op": "db.select", "table": table, "where": where})

        def insert(self, table, data):
            return ch.call({"op": "db.mutate", "mutation": {"table": table, "operation": "insert", "data": data}})

        def update(self, table, data, where=None):
            return ch.call({"op": "db.mutate", "mutation": {"table": table, "operation": "update", "data": data, "where": where}})

        def delete(self, table, where=None):
            return ch.call({"op": "db.mutate", "mutation": {"table": table, "operation": "delete", "data": {}, "where": where}})

    class API:
        def fetch(self, url):
            return ch.call({"op": "http.fetch", "url": str(url)})

    class Agents:
        def send(self, to, message):
            return ch.call({"op": "ipc.send", "to": to, "message": message})

        def recv(self):
            return ch.call({"op": "ipc.recv"})

    return DB(), API(), Agents()


class LogStream:
    """print() → log frames, one per line."""

    def __init__(self, ch, level):
        self.ch, self.level, self.buf = ch, level, ""

    def write(self, s):
        self.buf += s
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            self.ch.send({"t": "log", "level": self.level, "msg": line[:2000]})
        return len(s)

    def flush(self):
        if self.buf:
            self.ch.send({"t": "log", "level": self.level, "msg": self.buf[:2000]})
            self.buf = ""


def run(ch, code, context):
    db, api, agents = surface(ch)
    body = textwrap.indent(code, "    ") if code.strip() else "    pass"
    src = "def __agm_main__():\n" + body + "\n"
    env = {"__name__": "__sandbox__", "db": db, "api": api, "agents": agents, "context": context, "SyscallError": SyscallError}
    out, err = LogStream(ch, "log"), LogStream(ch, "error")
    sys.stdout, sys.stderr = out, err
    try:
        exec(compile(src, "sandbox.py", "exec"), env)
        value = env["__agm_main__"]()
        try:
            encoded = json.loads(json.dumps(value))
        except (TypeError, ValueError) as e:
            return {"t": "done", "ok": False, "error": f"result is not JSON-serialisable: {e}"}
        return {"t": "done", "ok": True, "value": encoded}
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — report every guest failure to the host
        tb = traceback.extract_tb(e.__traceback__)
        where = next((f"line {f.lineno - 1}" for f in reversed(tb) if f.filename == "sandbox.py"), "")
        return {"t": "done", "ok": False, "error": f"{type(e).__name__}: {e}" + (f" ({where})" if where else "")}
    finally:
        out.flush()
        err.flush()
        sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__


def connect(argv):
    if len(argv) >= 2 and argv[0] == "--unix":
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(argv[1])
        return s
    if len(argv) >= 2 and argv[0] == "--tcp":
        host, port = argv[1].rsplit(":", 1)
        return socket.create_connection((host, int(port)))
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    s.connect((HOST_CID, PORT))
    return s


def main(argv):
    ch = Channel(connect(argv))
    ch.send({"t": "ready", "python": sys.version.split()[0]})
    f = ch.recv()
    if f.get("t") != "run":
        return
    ch.send(run(ch, str(f.get("code", "")), f.get("context") or {}))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except SystemExit:
        pass
