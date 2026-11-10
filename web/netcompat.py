"""The network compatibility key of a KeeperFX source tree (src/net_compat.h):
"<oldest protocol>-<protocol>/<simulation>", or "" for a tree from before it.
Builds whose keys agree play online together (web/server/src/netcompat.js)."""
import os
import re


def net_compat_key(checkout):
    try:
        with open(os.path.join(checkout, "src", "net_compat.h"), encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return ""
    values = {}
    for name in ("NET_PROTOCOL_OLDEST", "NET_PROTOCOL_VERSION", "NET_SIM_VERSION"):
        m = re.search(rf"^#define\s+{name}\s+(\d+)", text, re.M)
        if not m:
            return ""
        values[name] = int(m.group(1))
    return f'{values["NET_PROTOCOL_OLDEST"]}-{values["NET_PROTOCOL_VERSION"]}/{values["NET_SIM_VERSION"]}'
