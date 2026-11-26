# Compara os traços dos dois lados (o JSON de traco.mjs) para um tipo de quadro.
#
#   python3 compara-traco.py traco.json [tipo] [modo] [regex]
#
#   tipo   "desafio" (o padrão) ou "site"
#   modo   "resumo" (o padrão): por função, quantas chamadas diferem e quantas só um lado fez
#          "difere": cada chamada igual com resposta diferente, com as respostas dos dois lados
#          "so-direto" e "so-motor": as chamadas que só um lado fez
#   regex  filtra as chamadas do modo escolhido
#
# Números longos e a porta da bancada são normalizados. Identificadores sorteados a cada carga
# aparecem como "só um lado": o sinal está em "difere" e nas funções que só o motor chama.
import json, sys, re, collections
d = json.load(open(sys.argv[1])); tipo = sys.argv[2] if len(sys.argv) > 2 else 'desafio'
modo = sys.argv[3] if len(sys.argv) > 3 else 'resumo'; filtro = re.compile(sys.argv[4]) if len(sys.argv) > 4 else None
def carrega(col):
    m = collections.OrderedDict()
    for q in d[col]:
        if q['tipo'] != tipo: continue
        for l in q['linhas']:
            t, _, resto = l.partition(' ')
            if resto.startswith('#') or resto.startswith('!'): continue
            for sep in (' -> ', ' !! '):
                i = resto.rfind(sep)
                if i >= 0: break
            chave, res = (resto[:i], resto[i:]) if i >= 0 else (resto, '')
            m.setdefault(chave, []).append(res)
    return m
norm = lambda s: re.sub(r'127\.0\.0\.1:\d+', 'H', re.sub(r'\d{6,}', 'N', s))
A, B = carrega('direto'), carrega('motor')
fn = lambda k: k.split('(', 1)[0]
porfn = collections.defaultdict(lambda: [0, 0, 0, 0])  # só direto, só motor, difere, igual
dif, soA, soB = [], [], []
for k in A:
    if k in B:
        ra, rb = set(map(norm, A[k])), set(map(norm, B[k]))
        if ra == rb: porfn[fn(k)][3] += 1
        else: porfn[fn(k)][2] += 1; dif.append((k, ra, rb))
    else: porfn[fn(k)][0] += 1; soA.append(k)
for k in B:
    if k not in A: porfn[fn(k)][1] += 1; soB.append(k)
if modo == 'resumo':
    print('chaves direto=%d motor=%d  iguais=%d diferem=%d só-direto=%d só-motor=%d' % (len(A), len(B), sum(v[3] for v in porfn.values()), len(dif), len(soA), len(soB)))
    for f, v in sorted(porfn.items(), key=lambda x: -(x[1][2] * 3 + x[1][0] + x[1][1])):
        if v[0] + v[1] + v[2] == 0: continue
        print('%-62s só-direto=%-4d só-motor=%-4d difere=%-4d igual=%d' % (f[:62], v[0], v[1], v[2], v[3]))
elif modo == 'difere':
    for k, ra, rb in dif:
        if filtro and not filtro.search(k): continue
        print(k[:230]); print('     direto:', ' | '.join(sorted(ra))[:300]); print('     motor: ', ' | '.join(sorted(rb))[:300])
elif modo in ('so-direto', 'so-motor'):
    for k in (soA if modo == 'so-direto' else soB):
        if filtro and not filtro.search(k): continue
        print(k[:260], (A if modo == 'so-direto' else B)[k][0][:120])
