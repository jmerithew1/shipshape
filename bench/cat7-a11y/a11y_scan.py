import os, re, sys, json

ROOT = r"C:\Users\merit\OneDrive\Desktop\shipshape\web\src"

files = []
for dp, dn, fn in os.walk(ROOT):
    dn[:] = [d for d in dn if d not in ("node_modules", "dist", "dev-dist", "__mocks__")]
    for f in fn:
        if f.endswith((".tsx", ".ts")):
            files.append(os.path.join(dp, f))

def find_tag_blocks(src, tagname):
    """Yield (start_idx, open_tag_str, inner_str) for <tagname ...> ... </tagname>, handling nesting."""
    out = []
    for m in re.finditer(r"<" + tagname + r"(?=[\s>/])", src):
        i = m.start()
        # find end of open tag, respecting braces/quotes
        j = m.end()
        depth_brace = 0
        quote = None
        while j < len(src):
            c = src[j]
            if quote:
                if c == quote and src[j-1] != "\\":
                    quote = None
            elif c in "\"'`":
                quote = c
            elif c == "{":
                depth_brace += 1
            elif c == "}":
                depth_brace -= 1
            elif depth_brace == 0 and c == ">":
                break
            j += 1
        open_tag = src[i:j+1]
        if open_tag.rstrip().endswith("/>"):
            out.append((i, open_tag, ""))
            continue
        # find matching close tag
        k = j + 1
        nest = 1
        pat = re.compile(r"</?" + tagname + r"(?=[\s>/])")
        pos = k
        inner_end = None
        while True:
            mm = pat.search(src, pos)
            if not mm:
                break
            if src[mm.start():mm.start()+2] == "</":
                nest -= 1
                if nest == 0:
                    inner_end = mm.start()
                    break
            else:
                # could be self-closing; check
                # crude: find its '>'
                e = src.find(">", mm.end())
                if e != -1 and src[e-1] == "/":
                    pass
                else:
                    nest += 1
            pos = mm.end()
        if inner_end is None:
            inner_end = len(src)
        out.append((i, open_tag, src[j+1:inner_end]))
    return out

def line_of(src, idx):
    return src.count("\n", 0, idx) + 1

report = {"iconbtn": [], "divclick": [], "inputs": [], "svg": [], "img": []}

for path in files:
    if not path.endswith(".tsx"):
        continue
    src = open(path, encoding="utf-8", errors="replace").read()
    rel = path

    # ---- buttons ----
    for idx, open_tag, inner in find_tag_blocks(src, "button"):
        has_aria = "aria-label" in open_tag or "aria-labelledby" in open_tag or "title=" in open_tag
        # visible text = strip nested tags & expressions
        txt = re.sub(r"<[^>]*>", "", inner)
        txt = re.sub(r"\{[^{}]*\}", "", txt)
        txt = txt.strip()
        # detect icon-only: inner contains only components/svg
        has_component = re.search(r"<[A-Z]", inner) or "<svg" in inner
        if not has_aria and not txt and has_component:
            report["iconbtn"].append((rel, line_of(src, idx), open_tag[:160].replace("\n", " "), inner[:120].replace("\n", " ")))

    # ---- div/span onClick ----
    for tag in ("div", "span"):
        for idx, open_tag, inner in find_tag_blocks(src, tag):
            if "onClick=" not in open_tag:
                continue
            has_role = "role=" in open_tag
            has_tab = "tabIndex" in open_tag
            has_key = "onKeyDown" in open_tag or "onKeyPress" in open_tag or "onKeyUp" in open_tag
            if not (has_role and has_tab and has_key):
                report["divclick"].append((rel, line_of(src, idx), tag, has_role, has_tab, has_key, open_tag[:200].replace("\n", " ")))

    # ---- inputs ----
    for tag in ("input", "textarea", "select"):
        for idx, open_tag, inner in find_tag_blocks(src, tag):
            if re.search(r'type=["\'](hidden|submit|button)["\']', open_tag):
                continue
            has_name = ("aria-label" in open_tag or "aria-labelledby" in open_tag
                        or "title=" in open_tag)
            has_id = re.search(r'\bid=', open_tag)
            ph_only = ("placeholder" in open_tag) and not has_name
            report["inputs"].append((rel, line_of(src, idx), tag, has_name, bool(has_id), ph_only, open_tag[:180].replace("\n", " ")))

    # ---- svg ----
    for idx, open_tag, inner in find_tag_blocks(src, "svg"):
        if "aria-hidden" in open_tag or 'role="img"' in open_tag or "aria-label" in open_tag:
            continue
        report["svg"].append((rel, line_of(src, idx)))

    # ---- img ----
    for idx, open_tag, inner in find_tag_blocks(src, "img"):
        if "alt=" not in open_tag:
            report["img"].append((rel, line_of(src, idx), open_tag[:200].replace("\n", " ")))

print("=== ICON-ONLY BUTTONS (no accessible name):", len(report["iconbtn"]))
for r in report["iconbtn"]:
    print(f"{r[0]}:{r[1]}  OPEN={r[2]}  INNER={r[3]}")

print()
print("=== DIV/SPAN onClick missing role/tabIndex/key:", len(report["divclick"]))
for r in report["divclick"]:
    print(f"{r[0]}:{r[1]} <{r[2]}> role={r[3]} tab={r[4]} key={r[5]}  {r[6]}")

print()
unl = [r for r in report["inputs"] if not r[3]]
print("=== INPUTS without aria-label/title:", len(unl), "of", len(report["inputs"]))
for r in unl:
    print(f"{r[0]}:{r[1]} <{r[2]}> hasId={r[4]} placeholderOnly={r[5]}  {r[6]}")

print()
print("=== SVG without aria-hidden/role=img:", len(report["svg"]))
from collections import Counter
c = Counter(r[0] for r in report["svg"])
for k, v in c.most_common(30):
    print(f"{v:4d}  {k}")

print()
print("=== IMG without alt:", len(report["img"]))
for r in report["img"]:
    print(f"{r[0]}:{r[1]}  {r[2]}")
