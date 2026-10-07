#!/usr/bin/env python3
"""
Check the shipped nginx files against nginx's own directive grammar.

nginx itself is not installed on a CI runner, and a config that nginx rejects is only
found out on the server, at the moment an operator is trying to put HTTPS in front of a
node. This parses each file in strict mode with `crossplane` (names, contexts and argument
counts of every directive), so a directive that older nginx does not know fails here: the
interface file once used `http2 on;`, which is a startup error on the nginx 1.18 and 1.24
that Ubuntu 22.04 and 24.04 ship, and `listen 443 ssl http2;` is accepted by all of them.

It also runs the exact `sed` pipeline that docs/ORACLE-VPS-DEPLOYMENT.md tells operators to
use to make one site per network, for all four networks, and checks that the four results
sit in one nginx without colliding (distinct upstream names, the right port and hostname).

    pip install crossplane
    python3 scripts/check-nginx-conf.py

Exit code 0 = every file parses and the generated sites are right.
"""
import os
import subprocess
import sys
import tempfile

try:
    import crossplane
except ImportError:
    sys.exit("crossplane is not installed:  pip install crossplane")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
INTERFACE_CONF = os.path.join(ROOT, "obsidian-interface", "deployment", "nginx", "obsidian-interface.conf")
NODE_CONF = os.path.join(ROOT, "obsidian-core", "deployment", "nginx", "obsidian-node.conf")

# The rate-limit zones the files refer to live in http{}; the files say to add them there.
INTERFACE_ZONES = "limit_req_zone $binary_remote_addr zone=obsidian_auth:10m rate=30r/m;\n" \
                  "limit_req_zone $binary_remote_addr zone=obsidian_api:10m rate=600r/m;\n"
NODE_ZONES = "limit_req_zone $binary_remote_addr zone=obsidian_tx:10m rate=30r/m;\n" \
             "limit_req_zone $binary_remote_addr zone=obsidian_read:10m rate=300r/m;\n"

# Port of each network's interface: the upstream the generated site must point at.
INTERFACES = {"devnet": 38788, "testnet": 18788, "staging": 28788, "mainnet": 8788}

failures = []


def wrap(zones, *includes):
    body = "".join(f"  include {path};\n" for path in includes)
    return "events {}\nhttp {\n" + "".join(f"  {line}\n" for line in zones.splitlines()) + body + "}\n"


def grammar_errors(config_text, label):
    with tempfile.NamedTemporaryFile("w", suffix=".conf", delete=False) as handle:
        handle.write(config_text)
        path = handle.name
    try:
        payload = crossplane.parse(path, check_ctx=True, check_args=True, strict=True, comments=False)
    finally:
        os.unlink(path)
    return [f"{label}: line {e.get('line')}: {e['error']}" for cfg in payload["config"] for e in cfg.get("errors", [])]


def check(label, errors):
    print(("ok    " if not errors else "FAIL  ") + label)
    for error in errors:
        print("        " + error)
    failures.extend(errors)


check("the interface site as shipped", grammar_errors(wrap(INTERFACE_ZONES, INTERFACE_CONF), "obsidian-interface.conf"))
check("the node RPC proxy as shipped", grammar_errors(wrap(NODE_ZONES, NODE_CONF), "obsidian-node.conf"))

# The same transformation ORACLE-VPS-DEPLOYMENT.md §7.x tells an operator to run.
work = tempfile.mkdtemp()
generated = []
for network, port in INTERFACES.items():
    domain = f"{network}.example.com"
    out = os.path.join(work, f"obsidian-{network}.conf")
    subprocess.run(
        ["sed", "-e", f"s/obsidian\\.example/{domain}/g", "-e", f"s/127\\.0\\.0\\.1:[0-9]*;.*/127.0.0.1:{port};/",
         "-e", f"s/obsidian_interface/obsidian_interface_{network}/g", INTERFACE_CONF],
        check=True, stdout=open(out, "w"),
    )
    text = open(out).read()
    problems = grammar_errors(wrap(INTERFACE_ZONES, out), f"generated {network} site")
    if f"server 127.0.0.1:{port};" not in text:
        problems.append(f"generated {network} site: upstream is not on port {port}")
    if f"server_name {domain};" not in text or "obsidian.example" in text:
        problems.append(f"generated {network} site: server_name was not rewritten to {domain}")
    if f"upstream obsidian_interface_{network} " not in text or f"proxy_pass http://obsidian_interface_{network};" not in text:
        problems.append(f"generated {network} site: the upstream was not renamed for this network")
    check(f"the {network} site the guide generates", problems)
    generated.append(out)

check("all four generated sites together in one nginx", grammar_errors(wrap(INTERFACE_ZONES, *generated), "all four sites"))

if failures:
    sys.exit(f"\n{len(failures)} problem(s)")
print("\nevery nginx file parses, and the generated per-network sites are distinct and correct")
