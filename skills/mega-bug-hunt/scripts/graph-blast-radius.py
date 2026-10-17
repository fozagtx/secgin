#!/usr/bin/env python3
"""Code-graph index and bug blast-radius for mega-bug-hunt (stdlib only).

Bugs travel edges: a defect at one node that flows into a bigger sink becomes a bigger
bug. Index a source tree once (decompiled APK, archived JS bundles, any repo), then run
blast on every candidate in BOTH directions:

  backward reachability = entry points that reach the seed = attack surface rating
  forward blast radius  = sinks the seed reaches            = impact rating

Usage:
  graph-blast-radius.py index <src-dir> -o graph.json [--max-mb 8]
  graph-blast-radius.py blast graph.json <seed> [--max 25]
  graph-blast-radius.py dot graph.json [-o graph.dot] [seed]
Seed: a node name, a file path suffix, a symbol/method name, a route substring, or a
param name. Nodes: file:<rel>, sym:<name>, route:<VERB path>|route:STR <path>,
param:<name>. Edges: declares, declared_in, imports, calls, handled_by, uses.
Heuristic: cross-file reference edges are added only for route handlers, sink-named
symbols, long unique names, and path params, so 10k-file decompiled trees stay fast and
focused. Regex extraction, no language server: a chain is a lead, not proof.
"""
import json
import os
import re
import sys
from collections import deque

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".gradle", "build", "dist",
             "target", "vendor", "resources", "assets"}
SINK_WORDS = ("auth", "login", "token", "jwt", "session", "cookie", "admin", "password",
              "secret", "sql", "query", "exec", "eval", "system", "command", "upload",
              "write", "delete", "remove", "update", "redirect", "request", "http",
              "payment", "checkout", "transfer", "withdraw", "config")
KEYWORDS = {"if", "for", "while", "switch", "catch", "try", "do", "else", "return",
            "new", "function", "constructor", "super", "this", "class", "def",
            "import", "from", "require", "print", "synchronized", "sizeof",
            "interface", "enum", "case", "default", "public", "private", "protected",
            "static", "final", "void", "boolean", "int", "long", "double", "float",
            "char", "byte", "short", "assert", "throw", "throws", "elif", "with",
            "lambda", "yield", "await", "async", "not", "and", "or", "in", "is",
            "del", "global", "nonlocal", "pass", "break", "continue", "type",
            "struct", "impl", "fn", "let", "var", "const", "val", "when", "object",
            "package", "extends", "implements", "null", "true", "false", "undefined",
            "None", "True", "False", "self", "set", "get", "list", "dict", "map",
            "call", "run", "error", "Error", "Exception", "String", "Integer"}
ROUTE_RE = re.compile(r'@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(\s*(?:value\s*=\s*)?"([^"]+)"')
PATH_RE = re.compile(r'["\'](/[A-Za-z0-9_\-]+(?:/[A-Za-z0-9_\-{}$:.]+)+)["\']')
PARAM_RE = re.compile(r"\{([A-Za-z_]\w*)\}")
PY_DEF_RE = re.compile(r"^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+([A-Za-z_]\w*)", re.M)
PY_IMP_RE = re.compile(r"^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import|import[ \t]+([\w.]+))", re.M)
JS_DEF_RE = re.compile(r"(?:function[ \t]+([A-Za-z_$][\w$]*)|(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]+)?\(|class[ \t]+([A-Za-z_$][\w$]*))")
JS_METH_RE = re.compile(r"^[ \t]*(?:async[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\([^)]*\)[ \t]*\{", re.M)
JS_IMP_RE = re.compile(r"""(?:from[ \t]+["']([^"']+)["']|require\([ \t]*["']([^"']+)["'][ \t]*\))""")
JAVA_DEF_RE = re.compile(r"\b(?:class|interface|enum)[ \t]+([A-Za-z_]\w*)")
JAVA_IMP_RE = re.compile(r"^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+);", re.M)
CALLISH_RE = re.compile(r"\b([A-Za-z_$][\w$]*)[ \t]*\(")
IDENT_RE = re.compile(r"[A-Za-z_$][\w$]*")
LANGS = {".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".java", ".kt"}
FS_ROOTS = {"tmp", "usr", "etc", "var", "opt", "proc", "sys", "home", "dev", "root",
            "bin", "sbin", "lib", "private", "Users", "Applications", "Library", "System"}


def sink_flags(name):
    low = name.lower()
    return [w for w in SINK_WORDS if w in low]


def index_tree(src, max_mb):
    nodes = {}
    edges = []
    edge_seen = set()
    file_idents = {}
    sym_decl = {}      # sym name -> set of file nodes declaring it
    import_names = []  # (file node, imported stem)
    stems = {}         # file stem -> [file node]
    route_files = set()
    params = set()

    def add_node(name, kind, path):
        n = nodes.setdefault(name, {"kind": kind, "path": path, "sinks": []})
        if not n["sinks"]:
            n["sinks"] = sink_flags(name)

    def edge(a, b, kind):
        key = (a, b, kind)
        if key not in edge_seen:
            edge_seen.add(key)
            edges.append([a, b, kind])

    def add_route(fnode, verb, path, text, after):
        add_node("route:%s %s" % (verb, path), "route", nodes[fnode]["path"])
        edge("route:%s %s" % (verb, path), fnode, "handled_by")
        tail = text[after:after + 300]
        m = CALLISH_RE.search(tail)
        while m and m.group(1) in KEYWORDS:
            m = CALLISH_RE.search(tail, m.end())
        if m and m.group(1) not in KEYWORDS and len(m.group(1)) >= 3:
            name = m.group(1)
            add_node("sym:" + name, "sym", nodes[fnode]["path"])
            sym_decl.setdefault(name, set()).add(fnode)
            edge("route:%s %s" % (verb, path), "sym:" + name, "handled_by")
        for p in PARAM_RE.findall(path):
            add_node("param:" + p, "param", nodes[fnode]["path"])
            edge("route:%s %s" % (verb, path), "param:" + p, "uses")
            params.add(p)

    for root, dirs, names in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in names:
            ext = os.path.splitext(fn)[1].lower()
            if ext not in LANGS:
                continue
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, src)
            try:
                if os.path.getsize(path) > max_mb * 1024 * 1024:
                    continue
                text = open(path, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            fnode = "file:" + rel
            add_node(fnode, "file", rel)
            stems.setdefault(os.path.splitext(fn)[0], []).append(fnode)
            file_idents[fnode] = set(IDENT_RE.findall(text))
            decl = set()
            if ext == ".py":
                decl = {m.group(1) for m in PY_DEF_RE.finditer(text)}
                for m in PY_IMP_RE.finditer(text):
                    import_names.append((fnode, (m.group(1) or m.group(2)).split(".")[-1]))
            elif ext in (".js", ".jsx", ".ts", ".tsx", ".mjs"):
                decl = {(m.group(1) or m.group(2) or m.group(3)) for m in JS_DEF_RE.finditer(text)}
                decl |= {m.group(1) for m in JS_METH_RE.finditer(text) if m.group(1) not in KEYWORDS}
                for m in JS_IMP_RE.finditer(text):
                    spec = m.group(1) or m.group(2) or ""
                    base = os.path.basename(spec.split("?")[0])
                    import_names.append((fnode, os.path.splitext(base)[0]))
            else:  # java / kotlin
                decl = {m.group(1) for m in JAVA_DEF_RE.finditer(text)}
                decl |= {m.group(1) for m in CALLISH_RE.finditer(text) if m.group(1) not in KEYWORDS}
                for m in JAVA_IMP_RE.finditer(text):
                    import_names.append((fnode, m.group(1).split(".")[-1]))
                for m in ROUTE_RE.finditer(text):
                    add_route(fnode, m.group(1), m.group(2), text, m.end())
                    route_files.add(fnode)
            if ext not in (".java", ".kt"):  # route-like string literals, not fs paths
                for m in PATH_RE.finditer(text):
                    if m.group(1).lstrip("/").split("/", 1)[0] in FS_ROOTS:
                        continue
                    add_route(fnode, "STR", m.group(1), text, m.end())
            for s in decl:
                if s in KEYWORDS or len(s) < 3:
                    continue
                add_node("sym:" + s, "sym", rel)
                sym_decl.setdefault(s, set()).add(fnode)
                edge(fnode, "sym:" + s, "declares")

    for fnode, seg in import_names:  # resolve imports to same-tree files
        for target in stems.get(seg, []):
            if target != fnode:
                edge(fnode, target, "imports")
    for s, dfiles in sym_decl.items():  # declared_in back-edges
        for f in dfiles:
            edge("sym:" + s, f, "declared_in")
    cands = {s for s, d in sym_decl.items()
             if d & route_files or sink_flags(s) or len(s) > 20}
    for fnode, idents in file_idents.items():  # focused cross-file references
        for c in sorted(cands | params):
            if c in idents and fnode not in sym_decl.get(c, set()):
                if c in params:
                    edge(fnode, "param:" + c, "uses")
                else:
                    edge(fnode, "sym:" + c, "calls")
    return nodes, edges


def load_graph(path):
    g = json.load(open(path))
    adj, radj = {}, {}
    for a, b, _ in g["edges"]:
        adj.setdefault(a, []).append(b)
        radj.setdefault(b, []).append(a)
    return g["nodes"], adj, radj


def bfs(start, adj):
    seen, parents, q = {start}, {}, deque([start])
    while q:
        x = q.popleft()
        for y in adj.get(x, []):
            if y not in seen:
                seen.add(y)
                parents[y] = x
                q.append(y)
    return seen, parents


def path_from_root(end, parents):
    out = [end]
    while out[-1] in parents:
        out.append(parents[out[-1]])
    return out[::-1]  # [root, ..., end]


def path_to_root(start, parents, stop):
    out = [start]
    while out[-1] != stop and out[-1] in parents:
        out.append(parents[out[-1]])
    return out  # [start, ..., stop]


def resolve_seed(nodes, seed):
    if seed in nodes:
        return seed
    low = seed.lower()
    for n in nodes:
        if n.startswith("file:") and (n[5:] == seed or n[5:].endswith(seed) or seed.endswith(n[5:])):
            return n
    for n in nodes:
        base = n.split(":", 1)[1] if ":" in n else n
        if base.lower() == low:
            return n
    for n in nodes:
        if low in n.lower():
            return n
    sys.exit("seed not found in graph: " + seed)


def blast(nodes, adj, radj, seed_name, maxn):
    seed = resolve_seed(nodes, seed_name)
    fwd, fwd_p = bfs(seed, adj)
    bwd, bwd_p = bfs(seed, radj)
    meta = nodes[seed]
    print("seed: %s (%s, %s)" % (seed, meta["kind"], meta["path"] or "-"))
    fwd.discard(seed)
    bwd.discard(seed)
    print("forward blast radius: %d nodes" % len(fwd))
    for n in sorted(fwd, key=lambda x: nodes[x]["kind"])[:maxn]:
        print("  %s  (%s %s)" % (n, nodes[n]["kind"], nodes[n]["path"] or ""))
    sinks = [n for n in fwd if nodes[n]["sinks"]]
    print("sinks reached: %s" % (", ".join("%s [%s]" % (n, ",".join(nodes[n]["sinks"]))
                                          for n in sinks[:maxn]) or "none"))
    print("backward reachability: %d nodes" % len(bwd))
    for n in sorted(bwd, key=lambda x: nodes[x]["kind"])[:maxn]:
        print("  %s  (%s %s)" % (n, nodes[n]["kind"], nodes[n]["path"] or ""))
    entries = [n for n in bwd if nodes[n]["kind"] == "route" or "main" in n.lower()]
    print("entry points reaching the seed: %s" % (", ".join(entries[:maxn]) or "none"))
    entry_chains = [path_to_root(e, bwd_p, seed) for e in entries]
    entry_chains = [c for c in entry_chains if c[-1] == seed]
    chain = min(entry_chains, key=len) if entry_chains else [seed]
    sink_paths = [path_from_root(s, fwd_p) for s in sinks if nodes[s]["kind"] != "file"]
    sink_chain = min(sink_paths, key=len) if sink_paths else []
    print("amplification chain:")
    print("  " + " -> ".join(chain + sink_chain[1:]))


def dot_export(nodes, adj, out, seed_name):
    seed = resolve_seed(nodes, seed_name) if seed_name else None
    keep = {n for n in nodes if nodes[n]["kind"] in ("file", "route")}
    with open(out, "w") as f:
        f.write("digraph codegraph {\n  rankdir=LR;\n")
        for n in sorted(keep):
            shape = "ellipse" if nodes[n]["kind"] == "route" else "box"
            color = ", color=red, penwidth=2" if n == seed else ""
            f.write('  "%s" [shape=%s%s];\n' % (n, shape, color))
        for a in adj:
            for b in adj[a]:
                if a in keep and b in keep:
                    f.write('  "%s" -> "%s";\n' % (a, b))
        f.write("}\n")
    print("wrote %s" % out)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd, target = sys.argv[1], sys.argv[2]
    args = sys.argv[3:]

    def arg(name, default):
        return args[args.index(name) + 1] if name in args else default

    positional, skip_next = [], False
    for a in args:
        if skip_next:
            skip_next = False
        elif a.startswith("-"):
            skip_next = True
        else:
            positional.append(a)

    if cmd == "index":
        nodes, edges = index_tree(target, float(arg("--max-mb", "8")))
        out = arg("-o", "graph.json")
        json.dump({"nodes": nodes, "edges": edges}, open(out, "w"), indent=1)
        kinds = {}
        for m in nodes.values():
            kinds[m["kind"]] = kinds.get(m["kind"], 0) + 1
        print("indexed %s into %s (%d edges)" % (kinds, out, len(edges)))
    elif cmd == "blast":
        if not positional:
            sys.exit("blast needs a seed")
        nodes, adj, radj = load_graph(target)
        blast(nodes, adj, radj, positional[0], int(arg("--max", "25")))
    elif cmd == "dot":
        nodes, adj, _ = load_graph(target)
        dot_export(nodes, adj, arg("-o", "graph.dot"), positional[0] if positional else None)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
