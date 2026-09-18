#!/usr/bin/env python3
"""Turn private nginx/Tinyproxy syslog datagrams into credential-free journal events.

Only recognized categories and numeric fields leave this process. Raw datagrams
can contain bearer URLs, headers or cookie diagnostics and must never be printed.
The socket is owned by systemd, so it survives collector restarts.
"""
import datetime
import json
import re
import socket


RULES = (
    ("dns-failure", r"getaddrinfo|name or service not known|name resolution|could not resolve|unable to resolve"),
    ("connection-refused", r"connection refused"),
    ("connection-reset", r"connection reset|reset by peer"),
    ("timeout", r"timed? out|timeout"),
    ("network-unreachable", r"network is unreachable|no route to host"),
    ("permission-denied", r"permission denied|operation not permitted"),
    ("tls-failure", r"ssl_do_handshake|ssl_read|ssl_write|certificate|tls|ssl error"),
    ("connection-limit", r"maxclients|worker_connections|too many open files|maximum.*clients"),
    ("upstream-closed", r"upstream prematurely closed"),
    ("client-closed", r"client.*(?:closed|disconnected)|client.*gone away"),
    ("request-rejected", r"denied|not allowed|unauthorized|invalid request|bad request|too large"),
    ("connection-established", r"established connection|connect.*established|connection.*established"),
    ("connect-request", r"request.*connect\s|connect.*(?:port|host)|accepted.*connection"),
    ("connection-closed", r"closed connection|closing connection|closed.*connections"),
    ("connect-failure", r"connect\(\).*failed|could not connect|unable to connect"),
    ("read-failure", r"recv\(\).*failed|read.*(?:failed|error)"),
    ("write-failure", r"send\(\).*failed|write.*(?:failed|error)"),
    ("startup", r"starting|initializ|listening|reloading|logfile|configuration|shutting down|exiting"),
)


def classify(packet):
    text = packet.decode("utf-8", "replace")
    match = re.search(r"\b(helltube_nginx|tinyproxy)(?:\[(\d{1,10})\])?:\s*(.*)", text, re.S)
    if not match:
        return {"event": "connection-log.unrecognized"}
    source, pid, message = match.groups()
    event = {"event": "nginx.error" if source == "helltube_nginx" else "youtube-proxy.connection"}
    priority = re.match(r"<(\d{1,3})>", text)
    if priority:
        event["severity"] = int(priority[1]) % 8
    if pid:
        event["pid"] = int(pid)
    # nginx appends attacker-controlled request/host/referrer data here.
    summary = re.split(r", (?:client|server|request|upstream|host|referrer):", message, maxsplit=1)[0]
    event["cause"] = next((name for name, pattern in RULES if re.search(pattern, summary, re.I)), "unclassified")
    number = re.search(r"\((\d{1,5}):", summary)
    if number:
        event["errno"] = int(number[1])
    connection = re.search(r"\*(\d{1,20})\s", summary) if source == "helltube_nginx" else None
    if connection:
        event["connection"] = int(connection[1])
    return event


def main(fd=3):
    receiver = socket.socket(fileno=fd)
    while True:
        packet, _, flags, _ = receiver.recvmsg(65536)
        event = classify(packet)
        if flags & socket.MSG_TRUNC:
            event["truncated"] = True
        event["timestamp"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        print(json.dumps(event), flush=True)


if __name__ == "__main__":
    main()
