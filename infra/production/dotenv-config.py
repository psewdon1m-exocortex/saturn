#!/usr/bin/env python3
"""Edit deployment fields without interpreting text inside quoted opaque keys."""
import os
from pathlib import Path
import re
import sys
import tempfile

# Match top-level assignments, consuming a quoted multiline value as one entry.
# Same quoting/escape rules as the project's dotenv parser; never evaluate text.
LINE = re.compile(r"^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*\"(?:\\\"|[^\"])*\"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$", re.MULTILINE)

def entries(source):
    for match in LINE.finditer(source):
        value = (match[2] or "").strip()
        quoted = value[:1]
        if len(value) >= 2 and quoted in ["'", '"', '`'] and value[-1:] == quoted:
            value = value[1:-1]
        if quoted == '"':
            value = value.replace(r"\n", "\n").replace(r"\r", "\r")
        yield match, value

def main():
    filename, action, key, *values = sys.argv[1:]
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
        raise ValueError("Invalid deployment field")
    source = Path(filename).read_text(encoding="utf-8")
    matches = [(match, value) for match, value in entries(source) if match[1] == key]
    if action == "has":
        return 0 if matches else 1
    if action == "get":
        if matches: sys.stdout.write(matches[-1][1])
        return 0
    if action not in ["set", "remove"]:
        raise ValueError("Unknown deployment field action")
    if action == "set":
        if len(values) != 1 or any(char in values[0] for char in "\r\n"):
            raise ValueError("Machine deployment field must be single-line")
        replacement = key + "=" + values[0] + "\n"
    else: replacement = ""
    for match, _ in reversed(matches):
        source = source[:match.start()] + replacement + source[match.end():].lstrip("\n")
    if action == "set" and not matches:
        source = source.rstrip("\n") + "\n" + replacement
    target = Path(filename)
    fd, temporary = tempfile.mkstemp(prefix=".saturn-config-", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(source); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, target)
        directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    return 0

if __name__ == "__main__":
    sys.exit(main())
