#!/usr/bin/env python3
# A diferença entre as duas colunas de um JSON de quadro.mjs: só as chaves em que o motor diverge
# do direto. As listas de nomes (globais, proto, keys) saem como "só no direto" e "só no motor".
# Os nomes `_<24 hex>` são os que o desafio sorteia a cada carga, e ficam de fora.
import json, re, sys

d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "quadro.json"))
a = (d.get("direto") or {}).get("r")
b = (d.get("motor") or {}).get("r")
if not (isinstance(a, dict) and isinstance(b, dict)):
    print("direto:", str(a)[:300]); print("motor:", str(b)[:300]); sys.exit()

sorteado = re.compile(r"^(W\.)?_[0-9a-f]{24}$")
n = 0
for k in sorted(set(a) | set(b)):
    if sorteado.match(k): continue
    x, y = a.get(k), b.get(k)
    if x == y: continue
    n += 1
    if isinstance(x, list) and isinstance(y, list):
        sx = {v for v in x if not sorteado.match(str(v))}; sy = {v for v in y if not sorteado.match(str(v))}
        print(k, "só no direto", sorted(sx - sy), "só no motor", sorted(sy - sx))
    elif isinstance(x, dict) and isinstance(y, dict):
        for kk in sorted(set(x) | set(y)):
            if x.get(kk) != y.get(kk): print(f"{k}.{kk}\n   D: {str(x.get(kk))[:250]}\n   M: {str(y.get(kk))[:250]}")
    else:
        print(f"{k}\n   D: {str(x)[:250]}\n   M: {str(y)[:250]}")
print("chaves diferentes:", n)
