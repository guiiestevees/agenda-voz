# Bateria de frases para conferir se a Bee entende datas, horas e mudanças. Uso: python3 servidor/bateria-bee.py [voltas]
import json, sys, urllib.request, concurrent.futures as cf

URL = "https://agenda-voz.guiiestevees.workers.dev/"
AGENDA = """101 | seg., 09/11/2026 | 19:00 | Buscar a Júlia na clínica | não repete
102 | ter., 10/11/2026 | 16:00 | Dentista | não repete
103 | qua., 11/11/2026 | 07:00 | Academia | toda semana (seg, qua, sex)
104 | qui., 12/11/2026 | 10:00 | Reunião com o cliente | não repete
103 | sex., 13/11/2026 | 07:00 | Academia | toda semana (seg, qua, sex)
105 | sex., 13/11/2026 | 20:00 | Jantar com a Ana | não repete
106 | dom., 15/11/2026 | 09:00 | Missa | toda semana (dom)
103 | seg., 16/11/2026 | 07:00 | Academia | toda semana (seg, qua, sex)
106 | dom., 22/11/2026 | 09:00 | Missa | toda semana (dom)"""
NOTAS = "201 | Trocar a lâmpada"
AGORA = ("segunda-feira, 09/11/2026 17:05", "2026-11-09")

def acoes(r): return r.get("acoes") or []
def um(r, **kw):
    a = acoes(r)
    if len(a) != 1: return f"esperava 1 ação, veio {len(a)}"
    for k, v in kw.items():
        got = a[0].get(k)
        if callable(v):
            if not v(got): return f"{k}={got!r}"
        elif got != v: return f"{k}={got!r} (esperado {v!r})"
    return ""

CASOS = [
 ("podóloga amanhã às 3 da tarde", lambda r: um(r, acao="criar", data="2026-11-10", hora="15:00")),
 ("reunião daqui a 30 minutos", lambda r: um(r, acao="criar", data="2026-11-09", hora=lambda h: h in ("17:35", "17:30", "17:40"))),
 ("almoço com o Pedro amanhã ao meio-dia", lambda r: um(r, acao="criar", data="2026-11-10", hora="12:00")),
 ("médico dia 20 às 8 e meia", lambda r: um(r, acao="criar", data="2026-11-20", hora="08:30")),
 ("pilates toda segunda, quarta e sexta às 6 da manhã", lambda r: um(r, acao="criar", hora="06:00", repetir="semanal", diasSemana=lambda d: sorted(d or []) == [1, 3, 5])),
 ("aniversário da minha mãe dia 3 de dezembro", lambda r: um(r, acao="criar", data="2026-12-03", repetir="anual")),
 ("tomar remédio todo dia às 8 da noite", lambda r: um(r, acao="criar", hora="20:00", repetir="diaria")),
 ("cabeleireiro depois de amanhã às 9", lambda r: um(r, acao="criar", data="2026-11-11", hora="09:00")),
 ("feira no sábado às 10", lambda r: um(r, acao="criar", data="2026-11-14", hora="10:00")),
 ("hoje às 7 e meia buscar a Júlia no inglês", lambda r: um(r, acao="criar", data="2026-11-09", hora="19:30")),
 ("ligar pro banco às 11", lambda r: um(r, acao="criar", hora="11:00", data="2026-11-10")),
 ("pegar o pão às 3", lambda r: um(r, acao="criar", data="2026-11-10", hora="15:00")),
 ("às 6 levar o cachorro pra passear", lambda r: um(r, acao="criar", data="2026-11-09", hora="18:00")),
 ("me lembra de pagar o boleto amanhã", lambda r: um(r, acao="criar", data="2026-11-10", hora="09:00")),
 ("muda o dentista para quinta às 2", lambda r: um(r, acao="mudar", eventoId="102", data="2026-11-12", hora="14:00")),
 ("o dentista na verdade é às 5", lambda r: um(r, acao="mudar", eventoId="102", hora="17:00", data=lambda d: d in (None, "2026-11-10"))),
 ("adia a reunião com o cliente pra sexta no mesmo horário", lambda r: um(r, acao="mudar", eventoId="104", data="2026-11-13", hora=lambda h: h in (None, "10:00"))),
 ("a academia de quarta passa pras 8", lambda r: um(r, acao="mudar", eventoId="103", soNaData="2026-11-11", hora="08:00")),
 ("a academia agora vai ser sempre às 6 da manhã", lambda r: um(r, acao="mudar", eventoId="103", soNaData=None, hora="06:00")),
 ("atrasa o jantar com a Ana em uma hora", lambda r: um(r, acao="mudar", eventoId="105", hora="21:00")),
 ("desmarca o dentista", lambda r: um(r, acao="desmarcar", eventoId="102")),
 ("cancela a missa desse domingo", lambda r: um(r, acao="desmarcar", eventoId="106", soNaData="2026-11-15")),
 ("buscar a Júlia é amanhã no mesmo horário", lambda r: um(r, acao="mudar", eventoId="101", data="2026-11-10", hora=lambda h: h in (None, "19:00"))),
 ("Corrija o compromisso “Buscar a Júlia na clínica”, marcado para segunda, 09/11, 19:00: na verdade é às 6", lambda r: um(r, acao="mudar", eventoId="101", hora="18:00")),
 ("Corrija o compromisso “Dentista”, marcado para terça, 10/11, 16:00: é hoje às 7", lambda r: um(r, acao="mudar", eventoId="102", data="2026-11-09", hora="19:00")),
 ("me avisa uma hora antes do jantar", lambda r: um(r, acao="mudar", eventoId="105", lembreteMin=60)),
 ("preciso trocar o chuveiro", lambda r: um(r, acao="anotar")),
 ("marca a lâmpada pra sábado às 10", lambda r: um(r, acao="agendar", notaId="201", data="2026-11-14", hora="10:00")),
 ("médico terça às 4 e nutricionista quinta às 10", lambda r: "" if [(a["data"], a["hora"]) for a in acoes(r)] == [("2026-11-10", "16:00"), ("2026-11-12", "10:00")] else str([(a["data"], a["hora"]) for a in acoes(r)])),
 ("dentista amanhã às 3 da tarde", lambda r: um(r, acao="mudar", eventoId="102", hora="15:00")),
 ("jantar sexta às 8", lambda r: um(r, acao="criar", data="2026-11-13", hora="20:00")),
 ("reunião quinze pras 9 amanhã", lambda r: um(r, acao="criar", data="2026-11-10", hora="08:45")),
 ("o jantar com a Ana mudou pra sábado", lambda r: um(r, acao="mudar", eventoId="105", data="2026-11-14")),
 ("tira o aviso do jantar", lambda r: um(r, acao="mudar", eventoId="105", lembreteMin=-1)),
 ("academia na segunda que vem não vou", lambda r: um(r, acao="desmarcar", eventoId="103", soNaData="2026-11-16")),
 ("muda a missa pras 10 só no dia 22", lambda r: um(r, acao="mudar", eventoId="106", soNaData="2026-11-22", hora="10:00")),
 ("não vou na academia hoje", lambda r: um(r, acao="desmarcar", eventoId="103", soNaData="2026-11-09")),
 ("cancela a academia", lambda r: um(r, acao="desmarcar", eventoId="103", soNaData=None)),
 ("a missa de domingo vai ser às 11", lambda r: um(r, acao="mudar", eventoId="106", soNaData="2026-11-15", hora="11:00")),
 ("o que eu tenho amanhã?", lambda r: "" if r.get("tipo") == "responder" and "16" in r.get("resposta", "") else r.get("resposta")),
 ("tô livre sexta de manhã?", lambda r: "" if r.get("tipo") == "responder" else r.get("tipo")),
]

def rodar(caso):
    texto, conf = caso
    corpo = json.dumps({"texto": texto, "agora": AGORA[0], "hoje": AGORA[1], "agenda": AGENDA, "notas": NOTAS, "aparelho": "bateria-" + __import__("uuid").uuid4().hex[:12], "lembretePadrao": 15, "idioma": "pt"}).encode()
    req = urllib.request.Request(URL, corpo, {"Content-Type": "application/json", "Origin": "http://localhost:8000", "User-Agent": "curl/8.7.1"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=60))
    except Exception as e:
        return texto, f"ERRO {e}", None
    return texto, conf(r), r

voltas = int(sys.argv[1]) if len(sys.argv) > 1 else 1
falhas = 0
with cf.ThreadPoolExecutor(6) as ex:
    for texto, erro, r in ex.map(rodar, CASOS * voltas):
        if erro:
            falhas += 1
            resumo = [(a.get("acao"), a.get("eventoId"), a.get("soNaData"), a.get("data"), a.get("hora"), a.get("repetir"), a.get("lembreteMin")) for a in acoes(r or {})]
            print(f"✗ {texto}\n    {erro}\n    {resumo} | {(r or {}).get('resposta','')[:120]}")
print(f"\n{len(CASOS) * voltas - falhas}/{len(CASOS) * voltas} certos")
