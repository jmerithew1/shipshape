import os, re
ROOT = r"C:\Users\merit\OneDrive\Desktop\shipshape\web\src"
for sub in ("pages", "components"):
    base = os.path.join(ROOT, sub)
    print("#" * 30, sub.upper())
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if d not in ("node_modules", "__mocks__")]
        for f in sorted(fn):
            if not f.endswith(".tsx"): continue
            p = os.path.join(dp, f)
            src = open(p, encoding="utf-8", errors="replace").read()
            hs = [(src.count("\n",0,m.start())+1, int(m.group(1)))
                  for m in re.finditer(r"<h([1-6])\b", src)]
            if sub == "components" and not hs: continue
            levels = [h[1] for h in hs]
            issues = []
            if sub == "pages":
                if 1 not in levels: issues.append("NO_H1")
            prev = None
            for ln, lv in hs:
                if prev is not None and lv > prev + 1:
                    issues.append(f"SKIP h{prev}->h{lv}@L{ln}")
                prev = lv
            flag = "  <<< " + ", ".join(issues) if issues else ""
            print(f"{os.path.relpath(p, ROOT)}: {hs}{flag}")
