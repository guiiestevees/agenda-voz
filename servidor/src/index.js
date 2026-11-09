// Cérebro da Agenda por Voz: recebe a fala + a agenda da pessoa,
// pergunta ao Claude o que fazer e devolve as ações em JSON para o app aplicar.
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";

// capacitor://localhost = o app nativo do iPhone (Capacitor)
const ORIGENS = ["https://guiiestevees.github.io", "capacitor://localhost", "http://localhost:8000", "http://127.0.0.1:8000"];

// Haiku é o padrão (rápido e barato). Sonnet fica liberado para comparar a qualidade.
const MODELOS = ["claude-haiku-5-5", "claude-sonnet-5-5"];

const SISTEMA = `Você é a secretária pessoal de uma agenda no iPhone, falando português do Brasil.
A pessoa fala com você por voz (o texto vem de um ditado, pode ter erros de transcrição, muletas e repetições).
Sua tarefa: entender o pedido e devolver as ações para o app executar.

tipo:
- "agir": a pessoa quer criar, mudar ou desmarcar compromissos, criar hábitos, ou anotar/agendar/tirar anotações. Coloque em "acoes" UMA ação para CADA compromisso citado, na ordem em que foram falados. Ex.: "médico terça às 4 e dentista quinta às 10" → duas ações "criar".
- "responder": a pessoa quer saber algo da agenda ou das anotações ("o que tenho amanhã?", "que horas estou livre na sexta?", "o que eu tenho anotado?"). Responda em "resposta" e deixe "acoes" vazia.
- "nao_entendi": o pedido não tem nada a ver com agenda ou está incompreensível. "acoes" vazia.

Cada ação:
- acao "criar": novo compromisso. Preencha titulo, data, hora, lembreteMin, repetir e diasSemana; eventoId e soNaData = null.
- acao "mudar": alterar um compromisso que JÁ existe na agenda. Preencha eventoId e só os campos que mudam; os outros ficam null (repetir "manter").
- acao "desmarcar": cancelar um compromisso que já existe. Preencha eventoId; o resto null (repetir "manter").
- acao "habito": criar um HÁBITO, algo para fazer com frequência SEM horário marcado ("beber 2 litros de água todo dia", "ler 10 páginas", "meditar de segunda a sexta", "treinar 3 vezes por semana"). Preencha titulo (curto, ex.: "Beber 2L de água"), diasSemana ([] = todos os dias) e emoji (um emoji que combine). Se tiver horário marcado ("academia toda segunda às 7"), NÃO é hábito: é "criar" com repetição.
- acao "anotar": a pessoa lembrou de algo que precisa fazer, mas NÃO disse dia nem hora ("preciso trocar a lâmpada", "anota aí: comprar presente da Ana", "não posso esquecer de ligar pro banco", "tenho que renovar a CNH"). Preencha só titulo (curto, inicial maiúscula, ex.: "Trocar a lâmpada"). Se ela falar dia OU hora, não é anotação: é "criar".
- acao "agendar": a pessoa quer dar dia e hora para uma ANOTAÇÃO que já existe ("marca a lâmpada pra terça às 5", "aquela do banco, coloca amanhã de manhã"). Preencha notaId (da lista de anotações), data, hora e lembreteMin; titulo = null para manter o texto da anotação.
- acao "tirar_nota": a pessoa já fez ou quer apagar uma anotação ("já troquei a lâmpada", "apaga a anotação do presente"). Preencha notaId.

Regras:
- Nome de uma palavra só também é compromisso válido ("feira no sábado às 10" → "Feira"; "missa domingo às 9" → "Missa"). Só use "nao_entendi" se não der para saber o que é.
- titulo: só o nome do compromisso, curto e com inicial maiúscula ("Médico", "Academia", "Reunião com o João", "Tomar remédio"). Nunca inclua data, hora, lembrete ou palavras como "tenho", "marca", "me lembra".
- data no formato AAAA-MM-DD e hora HH:MM (24h), no fuso da pessoa. Use a lista de datas abaixo para saber o dia certo de "terça", "amanhã" etc. Hora de 1 a 12 SEM período ("às 7", "7 horas"), para HOJE ou sem dia: use a tabela "Hora SEM período" que vem na mensagem; ela já escolheu o próximo horário que ainda vai chegar (manhã ou noite). Nunca jogue para amanhã um "hoje" que ainda dá tempo de acontecer hoje. Se a pessoa disser o período ("da manhã", "da tarde", "da noite", "meio-dia", "madrugada") ou a hora em 24h ("19h", "às 15"), obedeça exatamente. Para outro dia ("terça às 4"), sem período: de 1 a 5 soma 12 ("às 3" → 15:00, "às 4" → 16:00), de 6 a 11 é manhã, 12 é meio-dia; mas se o próprio compromisso indica o período, siga ele (jantar, festa, balada, culto à noite → noite: "jantar sexta às 8" → 20:00; café da manhã → manhã). "3 da tarde" é 15:00, "8 da noite" é 20:00, "meio-dia e meia" é 12:30, "7 e meia" é :30, "7 e quinze" é :15, "quinze pras 8" é 7:45. Com hora mas sem dia → hoje, se o horário ainda vai chegar; senão amanhã. Com dia mas sem hora → 09:00. Sem dia E sem hora, é uma tarefa para lembrar → "anotar" (a não ser que a pessoa peça claramente para marcar agora). Se a pessoa falar vários compromissos e só disser o dia no primeiro, os seguintes são no mesmo dia.
- lembreteMin: minutos de antecedência do aviso. "me lembre 15 min antes" → 15; "me lembra de tomar remédio às 8" → 0; "1 dia antes" → 1440. Se a pessoa não falar nada sobre aviso ao criar, use o aviso padrão informado na mensagem; para aniversário, use 0. Em "mudar", null = não mexer e -1 = tirar o aviso.
- avisoDaquiMin / avisoHora: quando a pessoa pede o aviso num MOMENTO certo, e não com antecedência, NÃO faça conta: "me avisa daqui a 5 minutos" → avisoDaquiMin 5; "me lembra daqui a meia hora" → 30; "me avisa às 6" → avisoHora "18:00" (mesma regra de hora). Nesses casos lembreteMin = null (o app calcula a antecedência). "Me avisa 5 minutos antes" continua sendo lembreteMin 5. Nos outros casos, os dois = null. Vale para "criar" e para "mudar" ("me avisa daqui a 10 minutos da academia" → mudar com avisoDaquiMin 10).
- repetir: "nenhuma", "diaria", "semanal", "mensal" ou "anual". Para semanal, diasSemana com os dias (0=domingo, 1=segunda … 6=sábado), ex.: "toda segunda e quarta" → [1,3]; "de segunda a sexta" → [1,2,3,4,5]. Aniversário → "anual". Nos outros casos diasSemana = [].
- notaId: só em "agendar" e "tirar_nota", escolhido na lista de anotações pelo texto; nas outras ações, null.
- Antes de criar, confira a agenda: se a pessoa fala de um compromisso que JÁ EXISTE (mesmo nome ou quase) e diz outro dia ou horário para ele ("buscar a Júlia é amanhã", "o dentista na verdade é às 5", "a reunião passou pra sexta", "mudou o horário do jantar"), é "mudar" esse compromisso, e não "criar" outro igual. Só crie um novo com o mesmo nome se a pessoa disser claramente que é mais um ("outro dentista", "mais uma reunião"). Se o nome tiver um detalhe diferente (outro lugar ou outra pessoa: "buscar a Júlia no inglês" não é "buscar a Júlia na clínica"), é outro compromisso → "criar". "No mesmo horário" = mantém a hora (hora null).
- Para mudar/desmarcar, escolha o eventoId na agenda pelo nome e pela data mencionados. Se o compromisso se repete e a pessoa cita QUALQUER dia ("desse domingo", "de amanhã", "de hoje", "da semana que vem", "dia 22", "na segunda que vem"), mexa SÓ naquele dia: soNaData = a data daquela ocorrência. Só mexa na série toda (soNaData = null) quando a pessoa diz claramente que é para sempre ("cancela a academia", "não vou mais na missa", "a academia agora é sempre às 6", "toda semana"). Se ela fala de ir/fazer agora, sem dia ("quero ir na academia às 7 da noite", "vou na academia mais tarde"), é só a ocorrência de HOJE (ou a próxima, se hoje não tiver): soNaData = essa data. Na dúvida, mexa só em um dia: apagar a série por engano é muito pior.
- Se não achar o compromisso para mudar/desmarcar, use tipo "responder" e diga isso em "resposta".
- resposta: curta e simpática, como uma secretária falaria, confirmando tudo o que foi feito ou respondendo a pergunta. Ex.: "Anotado: médico terça às 16h, te aviso 15 minutos antes." Fale horários como "16h" ou "16h30" e dias como "terça" ou "amanhã". Sem emojis.
- Quando o tipo for "responder", organize a resposta em tópicos para leitura rápida, usando quebras de linha (\\n):
  1ª linha: uma frase curta de abertura (ex.: "Sua semana que vem:").
  Depois, para cada dia, uma linha só com o dia terminando em dois-pontos (ex.: "Terça, 03/11:") e, embaixo, um compromisso por linha começando com "• " no formato "• 16h – Médico".
  Horários livres no formato "• Livre das 11h às 16h", considerando só o horário em que a pessoa está acordada (das 8h às 22h) e contando 1h de duração para cada compromisso. Dia sem nada: "• Livre o dia todo".
  Se a pergunta for sobre um dia só, pule a linha do dia e liste direto os tópicos. Nada de parágrafos longos.`;

const nulo = (tipo) => ({ type: [tipo, "null"] });
const ESQUEMA = {
  type: "object",
  properties: {
    tipo: { type: "string", enum: ["agir", "responder", "nao_entendi"] },
    resposta: { type: "string" },
    acoes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          acao: { type: "string", enum: ["criar", "mudar", "desmarcar", "habito", "anotar", "agendar", "tirar_nota"] },
          emoji: nulo("string"),
          eventoId: nulo("string"),
          notaId: nulo("string"),
          soNaData: nulo("string"),
          titulo: nulo("string"),
          data: nulo("string"),
          hora: nulo("string"),
          lembreteMin: nulo("integer"),
          avisoDaquiMin: nulo("integer"),
          avisoHora: nulo("string"),
          repetir: { type: "string", enum: ["nenhuma", "diaria", "semanal", "mensal", "anual", "manter"] },
          diasSemana: { type: "array", items: { type: "integer" } },
        },
        required: ["acao", "emoji", "eventoId", "notaId", "soNaData", "titulo", "data", "hora", "lembreteMin", "avisoDaquiMin", "avisoHora", "repetir", "diasSemana"],
        additionalProperties: false,
      },
    },
  },
  required: ["tipo", "resposta", "acoes"],
  additionalProperties: false,
};

// "sexta-feira 30/10/2026", "sábado 31/10/2026"… para a IA não errar a conta dos dias
function proximosDias(dataISO) {
  const base = new Date(`${dataISO}T12:00:00Z`);
  if (isNaN(base)) return "";
  const nomes = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  return Array.from({ length: 15 }, (_, i) => {
    const d = new Date(base.getTime() + i * 86400000);
    // "terça" é a PRÓXIMA terça (mesmo que seja amanhã); a de depois é "terça da semana que vem"
    const nome = nomes[d.getUTCDay()], rotulo = i === 0 ? `hoje (${nome})` : i === 1 ? `amanhã = ${nome}` : i === 2 ? `depois de amanhã = ${nome}` : i < 7 ? nome : `${nome} da semana que vem`;
    return `${rotulo}: ${d.toISOString().slice(0, 10)}`;
  }).join("\n");
}

function cabecalhos(origem) {
  return {
    "Access-Control-Allow-Origin": ORIGENS.includes(origem) ? origem : ORIGENS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  };
}
const responder = (corpo, status, origem) => new Response(JSON.stringify(corpo), { status, headers: cabecalhos(origem) });

// Convites: POST soma 1 ao código do amigo (uma vez por aparelho/IP); GET devolve o total do código
const CODIGO = /^[A-Z0-9]{6}$/;
async function convite(req, env, origem) {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const codigo = (url.searchParams.get("codigo") || "").toUpperCase();
    if (!CODIGO.test(codigo)) return responder({ erro: "código inválido" }, 400, origem);
    return responder({ total: +(await env.CONVITES.get(`total:${codigo}`)) || 0 }, 200, origem);
  }
  if (req.method !== "POST") return responder({ erro: "use GET ou POST" }, 405, origem);
  let entrada;
  try { entrada = await req.json(); } catch { return responder({ erro: "JSON inválido" }, 400, origem); }
  const codigo = String(entrada.codigo || "").toUpperCase();
  if (!CODIGO.test(codigo)) return responder({ erro: "código inválido" }, 400, origem);
  const ip = req.headers.get("CF-Connecting-IP") || "?";
  const marca = `ip:${ip}:${codigo}`;
  if (await env.CONVITES.get(marca)) return responder({ ok: true, repetido: true }, 200, origem);
  await env.CONVITES.put(marca, "1", { expirationTtl: 60 * 60 * 24 * 365 });
  const total = (+(await env.CONVITES.get(`total:${codigo}`)) || 0) + 1;
  await env.CONVITES.put(`total:${codigo}`, String(total));
  return responder({ ok: true }, 200, origem);
}

// Limite diário alto, só contra abuso: ninguém usando normalmente chega perto.
// O limite por IP é bem maior porque muita gente no celular divide o mesmo IP.
export class ContadorUso extends DurableObject {
  async contar(dia) {
    let uso = await this.ctx.storage.get("uso");
    if (uso?.dia !== dia) uso = { dia, n: 0 };
    uso.n++;
    await this.ctx.storage.put("uso", uso);
    return uso.n;
  }
  async contarFunil(chave) {
    const n = (await this.ctx.storage.get(chave)) || 0;
    await this.ctx.storage.put(chave, n + 1);
  }
  async lerFunil() {
    return Object.fromEntries(await this.ctx.storage.list());
  }
}
// ---------- Avisos pelo WhatsApp: quem ligou o número e os próximos avisos de cada pessoa ----------
// Guarda só o necessário: o número, o nome, o fuso, um resumo da agenda (para a Bee entender pedidos)
// e os avisos dos próximos dias. Cada aviso é apagado ao ser enviado.
const LIMITE_DIA_WA = 40;
const RC_PROJETO = "06160d90";   // projeto Tap Bee no RevenueCat
const TIPOS_AVISO = ["conta", "remedio", "consulta", "trabalho", "treino", "festa", "geral"];
export class AvisosWhatsapp extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ligacoes (uid TEXT PRIMARY KEY, telefone TEXT NOT NULL, idioma TEXT, nome TEXT, criado INTEGER);
      CREATE TABLE IF NOT EXISTS codigos (codigo TEXT PRIMARY KEY, uid TEXT NOT NULL, idioma TEXT, nome TEXT, expira INTEGER);
      CREATE TABLE IF NOT EXISTS avisos (uid TEXT NOT NULL, chave TEXT NOT NULL, quando INTEGER NOT NULL, titulo TEXT, hora TEXT, PRIMARY KEY (uid, chave));
      CREATE TABLE IF NOT EXISTS envios (uid TEXT NOT NULL, dia TEXT NOT NULL, n INTEGER, PRIMARY KEY (uid, dia));
      CREATE TABLE IF NOT EXISTS tipos (titulo TEXT PRIMARY KEY, tipo TEXT);
      CREATE TABLE IF NOT EXISTS enviados (uid TEXT NOT NULL, chave TEXT NOT NULL, titulo TEXT, hora TEXT, dia TEXT, tipo TEXT, em INTEGER, PRIMARY KEY (uid, chave));
      CREATE TABLE IF NOT EXISTS pendentes (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, dados TEXT, em INTEGER);
      CREATE TABLE IF NOT EXISTS assinaturas (uid TEXT PRIMARY KEY, ativa INTEGER, em INTEGER);
      CREATE TABLE IF NOT EXISTS estilos (chave TEXT PRIMARY KEY, tipo TEXT, recado TEXT);`);
    // Colunas que chegaram depois da primeira versão
    for (const c of ["avisos ADD COLUMN dia TEXT", "avisos ADD COLUMN tipo TEXT", "ligacoes ADD COLUMN tz TEXT", "ligacoes ADD COLUMN lembrete INTEGER", "ligacoes ADD COLUMN agenda TEXT", "ligacoes ADD COLUMN notas TEXT", "avisos ADD COLUMN recado TEXT", "enviados ADD COLUMN recado TEXT"]) {
      try { this.sql.exec(`ALTER TABLE ${c}`); } catch {}
    }
  }
  linha(q, ...v) { return this.sql.exec(q, ...v).toArray()[0]; }
  async iniciar(uid, codigo, idioma, nome) {
    this.sql.exec("DELETE FROM codigos WHERE expira < ? OR uid = ?", Date.now(), uid);
    if (this.linha("SELECT uid FROM codigos WHERE codigo = ?", codigo)) return false;
    this.sql.exec("INSERT OR REPLACE INTO codigos VALUES (?, ?, ?, ?, ?)", codigo, uid, idioma, nome, Date.now() + 30 * 60000);
    return true;
  }
  // Assinatura ativa no RevenueCat (o app usa o mesmo código anônimo lá). A resposta vale por 6 horas.
  // Se o RevenueCat não responder, a Bee continua funcionando: assinante nenhum fica sem lembrete por erro nosso.
  async assinou(uid, fresco = false) {
    if (!this.env.RC_SECRET) return true;
    const guardada = this.linha("SELECT ativa, em FROM assinaturas WHERE uid = ?", uid);
    if (guardada && !fresco && Date.now() - guardada.em < 6 * 3600000) return !!guardada.ativa;
    try {
      const auth = { Authorization: `Bearer ${this.env.RC_SECRET}` };
      const base = `https://api.revenuecat.com/v2/projects/${RC_PROJETO}/customers/${encodeURIComponent(uid)}`;
      const ent = await fetch(`${base}/active_entitlements`, { headers: auth });
      let ativa = false;
      if (ent.ok) ativa = ((await ent.json()).items || []).length > 0;
      else if (ent.status !== 404) throw new Error(`RevenueCat ${ent.status}`);
      if (!ativa && ent.status !== 404) {
        const subs = await fetch(`${base}/subscriptions`, { headers: auth });
        if (!subs.ok) throw new Error(`RevenueCat ${subs.status}`);
        ativa = ((await subs.json()).items || []).some((x) => x.gives_access || x.status === "active" || x.status === "trialing");
      }
      this.sql.exec("INSERT OR REPLACE INTO assinaturas VALUES (?, ?, ?)", uid, ativa ? 1 : 0, Date.now());
      return ativa;
    } catch (e) {
      console.error("Assinatura: não conferiu", e.message);
      return guardada ? !!guardada.ativa : true;
    }
  }
  // Assinatura acabou: desliga o WhatsApp, avisa o app para voltar aos avisos do iPhone e tenta se despedir
  async desligarSemAssinatura(uid) {
    const l = this.linha("SELECT telefone, idioma FROM ligacoes WHERE uid = ?", uid);
    this.sql.exec("INSERT INTO pendentes (uid, dados, em) VALUES (?, ?, ?)", uid, JSON.stringify({ tipo: "saiu", motivo: "assinatura" }), Date.now());
    this.sql.exec("DELETE FROM avisos WHERE uid = ?", uid);
    this.sql.exec("DELETE FROM ligacoes WHERE uid = ?", uid);
    if (l) await textoWhatsapp(this.env, l.telefone, RESPOSTAS_WA.fim[l.idioma === "en_US" ? "en_US" : "pt_BR"]());
  }
  async ligacao(telefone) { return this.linha("SELECT * FROM ligacoes WHERE telefone = ?", telefone) || null; }
  // Mensagem que chegou: liga o número se trouxer um código válido, desliga com SAIR/STOP
  async receber(telefone, texto) {
    const ligado = this.linha("SELECT uid, idioma, nome FROM ligacoes WHERE telefone = ?", telefone);
    if (/^\s*(sair|parar|stop|cancelar)\s*$/i.test(texto)) {
      if (ligado) this.sql.exec("INSERT INTO pendentes (uid, dados, em) VALUES (?, ?, ?)", ligado.uid, JSON.stringify({ tipo: "saiu" }), Date.now());
      this.sql.exec("DELETE FROM avisos WHERE uid IN (SELECT uid FROM ligacoes WHERE telefone = ?)", telefone);
      this.sql.exec("DELETE FROM ligacoes WHERE telefone = ?", telefone);
      return { tipo: "saiu", idioma: ligado?.idioma };
    }
    // Código fácil ("favo 27") ou o antigo de 6 letras e números
    const limpo = texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
    const candidatos = [...[...limpo.matchAll(/([A-Z]{3,10})[\s-]*(\d{2})\b/g)].map((m) => m[1] + m[2]), ...(limpo.match(/\b[A-Z0-9]{6}\b/g) || [])];
    const codigo = candidatos.map((c) => this.linha("SELECT * FROM codigos WHERE codigo = ? AND expira > ?", c, Date.now())).find(Boolean);
    if (codigo) {
      this.sql.exec("DELETE FROM ligacoes WHERE telefone = ? OR uid = ?", telefone, codigo.uid);
      this.sql.exec("INSERT INTO ligacoes (uid, telefone, idioma, nome, criado) VALUES (?, ?, ?, ?, ?)", codigo.uid, telefone, codigo.idioma, codigo.nome, Date.now());
      this.sql.exec("DELETE FROM codigos WHERE codigo = ?", codigo.codigo);
      return { tipo: "ligado", idioma: codigo.idioma, nome: codigo.nome, uid: codigo.uid };
    }
    return { tipo: ligado ? "pedido" : "outro", idioma: ligado?.idioma };
  }
  async situacao(uid) {
    const l = this.linha("SELECT telefone FROM ligacoes WHERE uid = ?", uid);
    return l ? { ligado: true, final: l.telefone.slice(-4) } : { ligado: false };
  }
  async sair(uid) {
    this.sql.exec("DELETE FROM avisos WHERE uid = ?", uid);
    this.sql.exec("DELETE FROM ligacoes WHERE uid = ?", uid);
  }
  // A IA escolhe o tipo de lembrete e escreve um recado curto que combine com cada compromisso.
  // Fica guardado por idioma e nome do compromisso, então cada nome passa pela IA uma vez só.
  async estilosDe(titulos, idioma) {
    const chave = (t) => `v2|${idioma}|${t.toLowerCase()}`;   // v2: regras mais cuidadosas, recados antigos não valem mais
    const faltam = [...new Set(titulos)].filter((t) => !this.linha("SELECT tipo FROM estilos WHERE chave = ?", chave(t)));
    if (faltam.length && this.env.ANTHROPIC_API_KEY) {
      try {
        const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
        const ingles = idioma === "en_US";
        const resp = await client.beta.messages.create({
          model: MODELOS[0], max_tokens: 2500,
          output_config: { effort: "low", format: { type: "json_schema", schema: {
            type: "object", additionalProperties: false, required: ["itens"],
            properties: { itens: { type: "array", items: { type: "object", additionalProperties: false, required: ["i", "tipo", "recado"], properties: { i: { type: "integer" }, tipo: { type: "string", enum: TIPOS_AVISO }, recado: { type: "string" } } } } },
          } } },
          messages: [{ role: "user", content: `Você é a Bee, secretária simpática de um app de agenda. Para cada compromisso abaixo:
1. tipo: conta (pagar, resolver, entregar, renovar, comprar), remedio (remédio, vitamina, insulina), consulta (SÓ quando a própria pessoa vai ser atendida: médico, dentista, exame, terapia, cabeleireiro; levar ou buscar alguém é geral), trabalho (reunião, call, entrega de trabalho), treino (academia, corrida, pilates, esporte), festa (aniversário, festa, jantar, encontro, viagem, passeio) ou geral.
2. recado: UMA frase curta (até 70 caracteres), ${ingles ? "em inglês" : "em português do Brasil"}, para vir logo depois de "Oi, Gui!". Tem que servir para QUALQUER versão daquele compromisso, sem supor detalhes que a pessoa não disse (nada de documentos, roupas, presentes, comidas, trânsito ou objetos que não estão no nome). Prático e gentil, sem exagero, sem elogio e sem promessa da Bee ("conta comigo", "você vai arrasar"). Sem gênero (nada de "pronto/pronta", "tranquilo/tranquila"). No máximo 1 emoji, no fim. Sem quebra de linha. Se não tiver CERTEZA do que é o compromisso ou de uma frase que combine, devolva recado vazio "": é melhor não dizer nada do que dizer algo que não combina.
Exemplos: "Centro espírita" → "Que seja um momento de paz 🙏"; "Pagar boleto da luz" → "Resolvendo isso, é um peso a menos."; "Buscar a Júlia na clínica" → "Sai com uns minutinhos de folga pra não correr."; "Tomar losartana" → "Hora de cuidar da pressão 💛"; "Reunião X" ou "Projeto Y" → "" (não dá pra saber o que é).

${faltam.map((t, i) => `${i}. ${t}`).join("\n")}` }],
        });
        const r = JSON.parse(resp.content.find((b) => b.type === "text").text);
        for (const { i, tipo, recado } of r.itens) if (faltam[i]) this.sql.exec("INSERT OR REPLACE INTO estilos VALUES (?, ?, ?)", chave(faltam[i]), tipo, limparRecado(recado));
      } catch (e) { console.error("WhatsApp: não escreveu os recados", e.message); }
    }
    return Object.fromEntries(titulos.map((t) => { const e = this.linha("SELECT tipo, recado FROM estilos WHERE chave = ?", chave(t)); return [t, { tipo: e?.tipo || "geral", recado: e?.recado || "" }]; }));
  }
  // O app manda a lista inteira dos próximos avisos e o resumo da agenda; a lista antiga é trocada pela nova
  async sincronizar(uid, lista, idioma, nome, extra) {
    if (!this.linha("SELECT uid FROM ligacoes WHERE uid = ?", uid)) return { ligado: false };
    if (!(await this.assinou(uid))) { await this.desligarSemAssinatura(uid); return { ligado: false, motivo: "assinatura" }; }
    this.sql.exec("UPDATE ligacoes SET idioma = ?, nome = ?, tz = ?, lembrete = ?, agenda = ?, notas = ? WHERE uid = ?", idioma, nome, extra.tz, extra.lembrete, extra.agenda, extra.notas, uid);
    const agora = Date.now(), ate = agora + 8 * 86400000, validos = lista.filter((a) => a.quando > agora - 60000 && a.quando < ate);
    const estilos = await this.estilosDe(validos.map((a) => a.titulo), idioma);
    this.sql.exec("DELETE FROM avisos WHERE uid = ?", uid);
    for (const a of validos) this.sql.exec("INSERT OR REPLACE INTO avisos (uid, chave, quando, titulo, hora, dia, tipo, recado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", uid, a.chave, a.quando, a.titulo, a.hora, a.dia, estilos[a.titulo].tipo, estilos[a.titulo].recado);
    await this.agendar();
    return { ligado: true };
  }
  // Pedido feito pelo WhatsApp: guarda para o app aplicar e já ajusta os avisos daqui, caso o app demore a abrir
  async pedidoDoWhatsapp(uid, dados, novosAvisos, removerEventos) {
    this.sql.exec("INSERT INTO pendentes (uid, dados, em) VALUES (?, ?, ?)", uid, JSON.stringify(dados), Date.now());
    for (const id of removerEventos) this.sql.exec("DELETE FROM avisos WHERE uid = ? AND chave LIKE ?", uid, `${id}|%`);
    const idioma = this.linha("SELECT idioma FROM ligacoes WHERE uid = ?", uid)?.idioma || "pt_BR";
    const estilos = await this.estilosDe(novosAvisos.map((a) => a.titulo), idioma);
    for (const a of novosAvisos) this.sql.exec("INSERT OR REPLACE INTO avisos (uid, chave, quando, titulo, hora, dia, tipo, recado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", uid, a.chave, a.quando, a.titulo, a.hora, a.dia, estilos[a.titulo].tipo, estilos[a.titulo].recado);
    await this.agendar();
  }
  async avisoDoEvento(uid, eventoId) { return this.linha("SELECT * FROM avisos WHERE uid = ? AND chave LIKE ?", uid, `${eventoId}|%`) || null; }
  // Botões do aviso: "Feito" vai para o app; "Lembrar em 10 min" volta para a fila
  async botao(telefone, acao, chave) {
    const l = this.linha("SELECT uid, idioma FROM ligacoes WHERE telefone = ?", telefone);
    if (!l) return { idioma: null, ok: false };
    if (acao === "feito") {
      this.sql.exec("INSERT INTO pendentes (uid, dados, em) VALUES (?, ?, ?)", l.uid, JSON.stringify({ tipo: "feito", chave }), Date.now());
      return { idioma: l.idioma, ok: true };
    }
    const e = this.linha("SELECT * FROM enviados WHERE uid = ? AND chave = ?", l.uid, chave);
    if (!e) return { idioma: l.idioma, ok: false };
    this.sql.exec("INSERT OR REPLACE INTO avisos (uid, chave, quando, titulo, hora, dia, tipo, recado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", l.uid, `${chave}#${Date.now()}`, Date.now() + 10 * 60000, e.titulo, e.hora, e.dia, e.tipo, e.recado);
    await this.agendar();
    return { idioma: l.idioma, ok: true };
  }
  async pendentes(uid) { return this.sql.exec("SELECT id, dados FROM pendentes WHERE uid = ? ORDER BY id", uid).toArray().map((p) => ({ id: p.id, ...JSON.parse(p.dados) })); }
  async confirmar(uid, ids) { for (const id of ids) this.sql.exec("DELETE FROM pendentes WHERE uid = ? AND id = ?", uid, id); }
  async agendar() {
    const prox = this.linha("SELECT MIN(quando) AS q FROM avisos")?.q;
    if (prox) await this.ctx.storage.setAlarm(Math.max(prox, Date.now() + 1000));
  }
  // Hora de avisar: usa o texto aprovado que combina com o compromisso. Aviso atrasado demais é descartado
  async alarm() {
    const agora = Date.now(), dia = new Date().toISOString().slice(0, 10);
    const vencidos = this.sql.exec("SELECT a.*, l.telefone, l.idioma, l.nome FROM avisos a JOIN ligacoes l ON l.uid = a.uid WHERE a.quando <= ?", agora + 20000).toArray();
    const aprovados = new Set();
    if (vencidos.length) {
      try {
        const lista = await (await fetch(`${WA_API}${WA_CONTA}/message_templates?fields=name,language,status,category&limit=100`, { headers: { Authorization: `Bearer ${this.env.WA_TOKEN}` } })).json();
        // Só os de utilidade: os que a Meta passou para marketing custam bem mais e podem nem ser entregues
        for (const m of lista.data || []) if (m.status === "APPROVED" && m.category === "UTILITY") aprovados.add(`${m.name}|${m.language}`);
      } catch (e) { console.error("WhatsApp: não leu os modelos", e.message); }
    }
    const semAssinatura = new Set();
    for (const uid of new Set(vencidos.map((a) => a.uid))) if (!(await this.assinou(uid))) { semAssinatura.add(uid); await this.desligarSemAssinatura(uid); }
    for (const a of vencidos) {
      this.sql.exec("DELETE FROM avisos WHERE uid = ? AND chave = ?", a.uid, a.chave);
      if (agora - a.quando > 15 * 60000 || semAssinatura.has(a.uid)) continue;
      const n = this.linha("SELECT n FROM envios WHERE uid = ? AND dia = ?", a.uid, dia)?.n || 0;
      if (n >= LIMITE_DIA_WA) continue;
      const idioma = a.idioma === "en_US" ? "en_US" : "pt_BR", nome = a.nome || (idioma === "en_US" ? "there" : "tudo bem");
      const chave = a.chave.split("#")[0], quandoTxt = `${a.dia || ""} ${idioma === "en_US" ? "at" : "às"} ${a.hora}`.trim();
      const modelo = textoDoAviso(a.tipo, a.recado, idioma, aprovados);
      if (!modelo) continue;
      const valores = { nome, compromisso: a.titulo, quando: quandoTxt, hora: a.hora, recado: a.recado };
      const componentes = [{ type: "body", parameters: modelo.campos.map((c) => ({ type: "text", parameter_name: c, text: valores[c] })) }];
      if (modelo.botoes) componentes.push(
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `feito|${chave}` }] },
        { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `adiar|${chave}` }] });
      const ok = await enviarWhatsapp(this.env, a.telefone, { type: "template", template: { name: modelo.nome, language: { code: idioma }, components: componentes } });
      if (ok) {
        this.sql.exec("INSERT OR REPLACE INTO envios VALUES (?, ?, ?)", a.uid, dia, n + 1);
        this.sql.exec("INSERT OR REPLACE INTO enviados (uid, chave, titulo, hora, dia, tipo, em, recado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", a.uid, chave, a.titulo, a.hora, a.dia, a.tipo, agora, a.recado);
      }
    }
    this.sql.exec("DELETE FROM avisos WHERE uid NOT IN (SELECT uid FROM ligacoes)");
    this.sql.exec("DELETE FROM envios WHERE dia < ?", dia);
    this.sql.exec("DELETE FROM enviados WHERE em < ?", agora - 2 * 86400000);
    this.sql.exec("DELETE FROM codigos WHERE expira < ?", agora);
    await this.agendar();
  }
}
// Quantas pessoas chegam a cada tela do quiz: só um total por tela, sem identificar ninguém
const TELAS_FUNIL = new Set(["abertura", "nome", "parabens", "frases", "mente", "desejo", "trava", "existe", "demo", "trocar", "avisos", "chegou", "pote", "plano", "pagamento", "tentou_comprar", "jogo", "oferta", "comprou", "comprou_oferta"]);
async function funil(req, env, origem) {
  const contador = env.USO.get(env.USO.idFromName("funil"));
  if (req.method === "GET") {
    if (!env.FUNIL_CHAVE || req.headers.get("x-chave") !== env.FUNIL_CHAVE) return responder({ erro: "não autorizado" }, 401, origem);
    return responder(await contador.lerFunil(), 200, origem);
  }
  if (!ORIGENS.includes(origem)) return responder({ erro: "origem não permitida" }, 403, origem);
  let e;
  try { e = await req.json(); } catch { return responder({ erro: "JSON inválido" }, 400, origem); }
  if (!TELAS_FUNIL.has(e.tela) || !/^\d{1,3}$/.test(e.versao)) return responder({ erro: "tela inválida" }, 400, origem);
  await contador.contarFunil(`v${e.versao}|${e.tela}`);
  return responder({ ok: true }, 200, origem);
}
const ID_APARELHO = /^[a-z0-9-]{8,40}$/;
// Se o contador falhar, deixa passar: a pessoa não pode ficar sem a Bee por um problema nosso
async function dentroDoLimite(env, aparelho, ip) {
  try {
    const dia = new Date().toISOString().slice(0, 10);
    const contar = (chave) => env.USO.get(env.USO.idFromName(chave)).contar(dia);
    const limAparelho = +env.LIMITE_APARELHO || 300, limIp = +env.LIMITE_IP || 3000;
    if ((await contar(`ip:${ip}`)) > limIp) return false;
    if (ID_APARELHO.test(aparelho) && (await contar(`ap:${aparelho}`)) > limAparelho) return false;
    return true;
  } catch (e) {
    console.error("Contador de uso:", e.message);
    return true;
  }
}

// ---------- WhatsApp: a Meta confere o endereço (GET) e manda mensagens e status (POST) ----------
// A assinatura prova que o aviso veio mesmo da Meta; sem o segredo do app guardado, só registra
async function assinaturaOk(req, corpo, env) {
  if (!env.WA_APP_SECRET) return true;
  const assinatura = (req.headers.get("X-Hub-Signature-256") || "").replace("sha256=", "");
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WA_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const certa = [...new Uint8Array(await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(corpo)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return assinatura.length === certa.length && crypto.subtle.timingSafeEqual(new TextEncoder().encode(assinatura), new TextEncoder().encode(certa));
}
const WA_API = "https://graph.facebook.com/v23.0/";
const WA_NUMERO = "1388653214339890";
// Só para nós: confere se a chave da Meta funciona e como está o número do Tap Bee
async function estadoWhatsapp(req, env) {
  if (!env.FUNIL_CHAVE || req.headers.get("x-chave") !== env.FUNIL_CHAVE) return new Response("não autorizado", { status: 401 });
  const r = await fetch(`${WA_API}${WA_NUMERO}?fields=display_phone_number,verified_name,name_status,quality_rating,messaging_limit_tier,status`, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
  // Mostra os recados que a Bee escreveria para uma lista de compromissos (separados por |)
  const recados = new URL(req.url).searchParams.get("recados");
  if (recados) return new Response(JSON.stringify(await env.AVISOS.get(env.AVISOS.idFromName("avisos")).estilosDe(recados.split("|").slice(0, 20), new URL(req.url).searchParams.get("idioma") === "en" ? "en_US" : "pt_BR")), { headers: { "Content-Type": "application/json; charset=utf-8" } });
  // Confere se um código tem assinatura ativa no RevenueCat (sem guardar a resposta antiga)
  const rc = new URL(req.url).searchParams.get("rc");
  if (rc && ID_APARELHO.test(rc)) return new Response(JSON.stringify({ ativa: await env.AVISOS.get(env.AVISOS.idFromName("avisos")).assinou(rc, true) }), { headers: { "Content-Type": "application/json" } });
  const conta = new URL(req.url).searchParams.get("conta");
  if (/^\d{10,20}$/.test(conta || "")) {
    const ler = async (c) => (await fetch(`${WA_API}${c}`, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } })).json();
    return new Response(JSON.stringify({ conta: await ler(`${conta}?fields=id,name`), numeros: await ler(`${conta}/phone_numbers`), modelos: await ler(`${conta}/message_templates?limit=1`) }), { headers: { "Content-Type": "application/json" } });
  }
  // Quais contas do WhatsApp a chave alcança (sem mostrar a chave)
  const d = await (await fetch(`${WA_API}debug_token?input_token=${env.WA_TOKEN}`, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } })).json();
  const escopos = (d.data?.granular_scopes || []).map((g) => ({ escopo: g.scope, ids: g.target_ids }));
  return new Response(JSON.stringify({ numero: await r.json(), escopos }), { status: r.status, headers: { "Content-Type": "application/json" } });
}
const WA_CONTA = "2476906269502510";
// Avisos da Bee: a Meta só deixa a empresa puxar conversa com textos aprovados.
// Os primeiros (bee_lembrete_*) são gerais; os por situação (bee_*) trazem os botões Feito e Lembrar em 10 min.
const MODELOS_BEE = {
  pt_BR: [
    "Ei, {{nome}}! 🐝 Daqui a pouco tem *{{compromisso}}*, às {{hora}}. Bora que dá tempo!",
    "Oi, {{nome}}, passando pra lembrar: *{{compromisso}}* hoje às {{hora}}. Não vai me deixar falando sozinha, hein? 🐝",
    "Bzzz! 🐝 Lembrete da Bee: *{{compromisso}}* às {{hora}}. Já tá se arrumando, {{nome}}? Bora!",
    "Oi, {{nome}}! Sua secretária aqui 🐝 Às {{hora}} você tem *{{compromisso}}*. Conta comigo!",
    "Alerta de abelha! 🐝 *{{compromisso}}* começa às {{hora}}. Vai com tudo, {{nome}}, eu tô torcendo!",
    "Ei, {{nome}}, não esquece: *{{compromisso}}* às {{hora}}. Eu lembro, você arrasa. 🐝",
  ],
  en_US: [
    "Hey {{nome}}! 🐝 Coming up soon: *{{compromisso}}* at {{hora}}. You've got this!",
    "Hi {{nome}}, just a reminder: *{{compromisso}}* today at {{hora}}. Don't leave me talking to myself! 🐝",
    "Bzzz! 🐝 Bee reminder: *{{compromisso}}* at {{hora}}. Getting ready, {{nome}}? Let's go!",
    "Hi {{nome}}! Your secretary here 🐝 At {{hora}} you have *{{compromisso}}*. Count on me!",
    "Bee alert! 🐝 *{{compromisso}}* starts at {{hora}}. Go get it, {{nome}}, I'm rooting for you!",
    "Hey {{nome}}, don't forget: *{{compromisso}}* at {{hora}}. I remember, you shine. 🐝",
  ],
};
const MODELOS_POR_TIPO = {
  pt_BR: {
    conta: "Ei, {{nome}}, não esquece: *{{compromisso}}* {{quando}}. Depois é só relaxar! 🐝",
    remedio: "Oi, {{nome}}! Hora do remédio: *{{compromisso}}* {{quando}}. Cuidar de você vem primeiro 💛",
    consulta: "Oi, {{nome}}! 🐝 *{{compromisso}}* {{quando}}. Separa os documentos e vai com calma!",
    trabalho: "Oi, {{nome}}! 🐝 Passando pra lembrar: *{{compromisso}}* {{quando}}. Respira fundo, se organiza e vai lá, que você vai mandar bem!",
    treino: "Bora mexer o corpo, {{nome}}! 🐝 Seu treino tá chegando: *{{compromisso}}* {{quando}}. Pega a garrafinha d'água e partiu!",
    festa: "Oi, {{nome}}! 🐝 Tá chegando a hora: *{{compromisso}}* {{quando}}. Se arruma com calma e aproveita muito!",
    geral: "Oi, {{nome}}! 🐝 Passando pra te lembrar do seu compromisso: *{{compromisso}}* {{quando}}. Pode contar comigo!",
  },
  en_US: {
    conta: "Hey {{nome}}, don't forget: *{{compromisso}}* {{quando}}. Then you can relax! 🐝",
    remedio: "Hi {{nome}}! Medicine time: *{{compromisso}}* {{quando}}. Taking care of you comes first 💛",
    consulta: "Hi {{nome}}! 🐝 *{{compromisso}}* {{quando}}. Grab your documents and take it easy!",
    trabalho: "Hi {{nome}}! 🐝 *{{compromisso}}* {{quando}}. You're going to do great!",
    treino: "Time to move, {{nome}}! 🐝 Your workout is coming up: *{{compromisso}}* {{quando}}. Grab your water bottle and let's go!",
    festa: "Hi {{nome}}! 🐝 It's almost time: *{{compromisso}}* {{quando}}. Get ready at your own pace and have a great time!",
    geral: "Hi {{nome}}! 🐝 Just a friendly reminder about your plan: *{{compromisso}}* {{quando}}. You can count on me!",
  },
};
// Segunda geração: o compromisso vem primeiro, para bater o olho e saber do que se trata
const ASSINATURA_BEE = { pt_BR: "— Bee, sua secretária do Tap Bee", en_US: "— Bee, your Tap Bee secretary" };
const MODELOS_V2 = {
  pt_BR: {
    recado: "Oi, {{nome}}! {{recado}}\n\nQuando terminar, é só tocar em Feito aqui embaixo.",
    conta: "Oi, {{nome}}! Não deixa pra depois, hein? Resolvendo isso, é um peso a menos.",
    remedio: "Oi, {{nome}}! Hora de se cuidar. Sua saúde vem primeiro 💛",
    consulta: "Oi, {{nome}}! Separa os documentos e sai com calma, pra chegar sem pressa.",
    trabalho: "Oi, {{nome}}! Respira fundo e vai com tudo, você vai mandar bem.",
    treino: "Oi, {{nome}}! Bora mexer o corpo! Leva a garrafinha d'água 💪",
    festa: "Oi, {{nome}}! Aproveita bastante e curte cada momento 🎉",
    geral: "Oi, {{nome}}! Passando pra te lembrar com carinho 💛",
  },
  en_US: {
    recado: "Hi {{nome}}! {{recado}}\n\nWhen you're done, just tap Done below.",
    conta: "Hi {{nome}}! Don't leave it for later. One less thing on your mind.",
    remedio: "Hi {{nome}}! Time to take care of yourself. Your health comes first 💛",
    consulta: "Hi {{nome}}! Grab your documents and leave early, so you don't have to rush.",
    trabalho: "Hi {{nome}}! Take a deep breath and go for it, you'll do great.",
    treino: "Hi {{nome}}! Time to move! Bring your water bottle 💪",
    festa: "Hi {{nome}}! Have a great time and enjoy every moment 🎉",
    geral: "Hi {{nome}}! Just a friendly reminder, with care 💛",
  },
};
// Terceira geração: curta, sem assinatura e com tom de lembrete (a Meta cobra "marketing" quando o texto anima ou elogia)
const MODELOS_V3 = {
  pt_BR: {
    lembrete: "🐝 *{{compromisso}}*\n🕐 {{quando}}\n\nOi, {{nome}}! Passando pra te lembrar desse compromisso.",
    recado: "🐝 *{{compromisso}}*\n🕐 {{quando}}\n\nOi, {{nome}}! {{recado}}\n\nQualquer mudança, é só me falar por aqui.",
  },
  en_US: {
    lembrete: "🐝 *{{compromisso}}*\n🕐 {{quando}}\n\nHi {{nome}}! Just reminding you about this plan.",
    recado: "🐝 *{{compromisso}}*\n🕐 {{quando}}\n\nHi {{nome}}! {{recado}}\n\nIf anything changes, just tell me here.",
  },
};
const textoV2 = (idioma, meio) => `🐝 *{{compromisso}}*\n🕐 {{quando}}\n\n${meio}\n\n${ASSINATURA_BEE[idioma]}`;
// O recado da IA cabe numa variável do WhatsApp: uma linha, sem formatação, curto
const limparRecado = (t) => String(t || "").replace(/[\r\n\t*_~`]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 90);
const BOTOES_BEE = { pt_BR: ["Feito", "Lembrar em 10 min"], en_US: ["Done", "Remind me in 10 min"] };
const EXEMPLO_BEE = { pt_BR: ["Gui", "Pagar o boleto", "10:00", "hoje às 10:00", "Resolvendo isso, é um peso a menos na cabeça."], en_US: ["Gui", "Pay the bill", "10:00 AM", "today at 10:00 AM", "Getting this done is one less thing on your mind."] };
// Recado da IA quando ela teve certeza do que é o compromisso; senão o lembrete simples; senão um dos primeiros gerais
function textoDoAviso(tipo, recado, idioma, aprovados) {
  const ok = (n) => aprovados.has(`${n}|${idioma}`);
  if (recado && ok("bee3_recado")) return { nome: "bee3_recado", campos: ["compromisso", "quando", "nome", "recado"], botoes: true };
  if (ok("bee3_lembrete")) return { nome: "bee3_lembrete", campos: ["compromisso", "quando", "nome"], botoes: true };
  const velhos = [1, 2, 3, 4, 5, 6].map((i) => `bee_lembrete_${i}`).filter(ok);
  return velhos.length ? { nome: velhos[Math.floor(Math.random() * velhos.length)], campos: ["nome", "compromisso", "hora"], botoes: false } : null;
}
// Só para nós: GET mostra a situação dos modelos na Meta; POST manda os que faltam para aprovação
async function modelosWhatsapp(req, env) {
  if (!env.FUNIL_CHAVE || req.headers.get("x-chave") !== env.FUNIL_CHAVE) return new Response("não autorizado", { status: 401 });
  const auth = { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" };
  const lista = await (await fetch(`${WA_API}${WA_CONTA}/message_templates?fields=name,language,status,category&limit=100`, { headers: auth })).json();
  if (req.method === "GET") return new Response(JSON.stringify(lista), { headers: { "Content-Type": "application/json" } });
  const existe = new Set((lista.data || []).map((m) => `${m.name}|${m.language}`));
  const pedidos = [];
  for (const [idioma, textos] of Object.entries(MODELOS_BEE)) textos.forEach((texto, i) => pedidos.push({ name: `bee_lembrete_${i + 1}`, idioma, texto, quarto: "hora" }));
  for (const [idioma, textos] of Object.entries(MODELOS_POR_TIPO)) for (const [tipo, texto] of Object.entries(textos)) pedidos.push({ name: `bee_${tipo}`, idioma, texto, quarto: "quando", botoes: BOTOES_BEE[idioma] });
  for (const [idioma, meios] of Object.entries(MODELOS_V2)) for (const [tipo, meio] of Object.entries(meios)) pedidos.push({ name: `bee2_${tipo}`, idioma, texto: textoV2(idioma, meio), quarto: "quando", botoes: BOTOES_BEE[idioma], recado: tipo === "recado" });
  for (const [idioma, textos] of Object.entries(MODELOS_V3)) for (const [tipo, texto] of Object.entries(textos)) pedidos.push({ name: `bee3_${tipo}`, idioma, texto, quarto: "quando", botoes: BOTOES_BEE[idioma], recado: tipo === "recado" });
  const resultado = [];
  for (const p of pedidos) {
    if (existe.has(`${p.name}|${p.idioma}`)) continue;
    const [nome, compromisso, hora, quando, recado] = EXEMPLO_BEE[p.idioma];
    const exemplos = [{ param_name: "nome", example: nome }, { param_name: "compromisso", example: compromisso }, { param_name: p.quarto, example: p.quarto === "hora" ? hora : quando }];
    if (p.recado) exemplos.push({ param_name: "recado", example: recado });
    const componentes = [{ type: "BODY", text: p.texto, example: { body_text_named_params: exemplos } }];
    if (p.botoes) componentes.push({ type: "BUTTONS", buttons: p.botoes.map((text) => ({ type: "QUICK_REPLY", text })) });
    const r = await fetch(`${WA_API}${WA_CONTA}/message_templates`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: p.name, language: p.idioma, category: "UTILITY", parameter_format: "NAMED", components: componentes }),
    });
    resultado.push({ name: p.name, idioma: p.idioma, status: r.status, resposta: await r.json() });
  }
  return new Response(JSON.stringify(resultado), { headers: { "Content-Type": "application/json" } });
}

// Mensagens livres só valem dentro da conversa que a pessoa abriu (24 horas); servem para confirmar e responder
async function enviarWhatsapp(env, para, corpo) {
  const r = await fetch(`${WA_API}${WA_NUMERO}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: para, ...corpo }),
  });
  if (!r.ok) console.error("WhatsApp: falha ao enviar", r.status, (await r.text()).slice(0, 300));
  return r.ok;
}
const textoWhatsapp = (env, para, texto) => enviarWhatsapp(env, para, { type: "text", text: { body: texto } });
const RESPOSTAS_WA = {
  ligado: { pt_BR: (n) => `Oi${n ? `, ${n}` : ""}! Que bom te ver por aqui 🐝\n\nA partir de agora, seus lembretes chegam nesta conversa, na hora certa.\n\nE pode me pedir o que precisar, escrevendo ou mandando áudio. Por exemplo: "marca dentista sexta às 3" ou "o que eu tenho amanhã?".\n\nSe um dia quiser parar, é só mandar SAIR.`, en_US: (n) => `Hi${n ? ` ${n}` : ""}! So glad to see you here 🐝\n\nFrom now on, your reminders will arrive in this chat, right on time.\n\nAnd you can ask me anything, by text or voice message. For example: "dentist Friday at 3" or "what do I have tomorrow?".\n\nIf you ever want to stop, just send STOP.` },
  saiu: { pt_BR: () => "Tudo bem! Não vou mais te avisar por aqui. Os avisos voltam para o iPhone. Para voltar, é só ativar de novo no Tap Bee. 🐝", en_US: () => "No problem! I won't remind you here anymore. Reminders go back to your iPhone. To come back, just turn it on again in Tap Bee. 🐝" },
  outro: { pt_BR: () => "Oi! 🐝 Eu sou a Bee, a secretária do Tap Bee. Para eu te avisar por aqui, ative em Ajustes → Avisos pelo WhatsApp no app.", en_US: () => "Hi! 🐝 I'm Bee, the Tap Bee secretary. To get reminders here, turn it on in Settings → WhatsApp reminders in the app." },
  feito: { pt_BR: () => "Boa! Marquei como feito ✅ 🐝", en_US: () => "Nice! Marked as done ✅ 🐝" },
  adiar: { pt_BR: () => "Combinado! Te lembro de novo em 10 minutos ⏰", en_US: () => "Deal! I'll remind you again in 10 minutes ⏰" },
  perdido: { pt_BR: () => "Esse lembrete já passou, mas tá tudo certo na sua agenda. 🐝", en_US: () => "That reminder has passed, but your calendar is all set. 🐝" },
  audio: { pt_BR: () => "Não consegui ouvir esse áudio direito. Pode mandar de novo ou escrever? 🐝", en_US: () => "I couldn't hear that voice message well. Can you send it again or type it? 🐝" },
  fim: { pt_BR: () => "Sua assinatura do Tap Bee terminou, então eu parei de te avisar por aqui. Seus avisos voltam a funcionar quando você assinar de novo no app. 🐝", en_US: () => "Your Tap Bee subscription ended, so I stopped reminding you here. Reminders work again when you subscribe in the app. 🐝" },
  assine: { pt_BR: () => "Os avisos pelo WhatsApp são para quem assina o Tap Bee. Assine no app e ative de novo em Ajustes. 🐝", en_US: () => "WhatsApp reminders are for Tap Bee subscribers. Subscribe in the app and turn it on again in Settings. 🐝" },
  erro: { pt_BR: () => "Tive um probleminha agora. Tenta de novo daqui a pouco? 🐝", en_US: () => "I had a little problem just now. Try again in a moment? 🐝" },
};

// ---------- Fuso de cada pessoa: o servidor fala de "hoje" e "amanhã" no horário dela ----------
const relogio = (tz, ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}`, utc: Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) };
};
const fusoOk = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "America/Sao_Paulo"; } };
// Dia e hora no relógio da pessoa → instante real
function instanteEm(tz, data, hora) {
  const [a, m, d] = data.split("-").map(Number), [h, mi] = hora.split(":").map(Number), chute = Date.UTC(a, m - 1, d, h, mi);
  return chute - (relogio(tz, chute).utc - chute);
}
function diaFalado(tz, data, idioma) {
  const hoje = relogio(tz, Date.now()).data, amanha = relogio(tz, Date.now() + 86400000).data;
  if (data === hoje) return idioma === "en_US" ? "today" : "hoje";
  if (data === amanha) return idioma === "en_US" ? "tomorrow" : "amanhã";
  return new Date(`${data}T12:00:00Z`).toLocaleDateString(idioma === "en_US" ? "en-US" : "pt-BR", { weekday: "long", timeZone: "UTC" });
}
const horaFalada = (hora, idioma) => {
  if (idioma !== "en_US") return hora;
  const [h, m] = hora.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

// O mesmo cérebro do app, usado também pelo WhatsApp
// "às 7" sem período: o próximo 7:00 ou 19:00 que ainda vai chegar, já calculado para a Bee não adivinhar
function tabelaHoras(agora, hoje) {
  // "17:05" (pt) ou "5:05 PM" (en)
  const m = String(agora).match(/(\d{1,2}):(\d{2})\s*([AaPp])?\.?\s*[Mm]?\.?\s*$/);
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(hoje)) return "";
  const h24 = m[3] ? (+m[1] % 12) + (/p/i.test(m[3]) ? 12 : 0) : +m[1];
  const minAgora = h24 * 60 + +m[2], amanha = new Date(Date.parse(`${hoje}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const pad = (n) => String(n).padStart(2, "0");
  return Array.from({ length: 12 }, (_, i) => {
    // 1 a 5 é tarde (ninguém marca 3 da madrugada sem dizer); 6 a 10 pode ser manhã ou noite; 11 e 12 são de dia
    const h = i + 1, opcoes = h <= 5 ? [(h + 12) * 60] : h <= 10 ? [h * 60, (h + 12) * 60] : [h * 60];
    const prox = opcoes.find((x) => x > minAgora);
    const [dia, min] = prox === undefined ? [amanha, opcoes[0]] : [hoje, prox];
    return `"às ${h}" → ${dia} ${pad(Math.floor(min / 60))}:00`;
  }).join("\n");
}
// Resposta que se contradiz ("Anotado!" sem nenhuma ação, ou "agir" vazio) não pode chegar na pessoa:
// ela acharia que salvou. Nesse caso, pergunta de novo ao modelo mais forte.
const confirmaSemAcao = (r) => (r.tipo === "agir" && !(r.acoes || []).length) || (r.tipo !== "agir" && /^(anotad|pront|marquei|ajustei|mudei|desmarquei|cancelei|agendei|feito|done|added|all set|moved|changed|cancel)/i.test(String(r.resposta || "").trim()));
// "Me avisa daqui a 5 minutos" vira antecedência: a conta é feita aqui, não pela IA
const minutosDoDia = (hora) => {
  const m = String(hora || "").match(/^(\d{1,2}):(\d{2})\s*([AaPp])?/);
  return m ? ((m[3] ? (+m[1] % 12) + (/p/i.test(m[3]) ? 12 : 0) : +m[1]) * 60 + +m[2]) : null;
};
const diaUTC = (data) => Date.parse(`${data}T00:00:00Z`);
// Dia e hora de um compromisso que já está na agenda (linha "id | seg., 09/11/2026 | 19:00 | ...")
// Sem dia certo, vale a próxima ocorrência que ainda não passou
function horarioNaAgenda(agenda, eventoId, soNaData, idioma, agoraMs) {
  let primeira = null;
  for (const linha of String(agenda).split("\n")) {
    const [id, dia, hora] = linha.split(" | ");
    if (id?.trim() !== eventoId) continue;
    const d = dia?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!d) continue;
    const [dd, mm] = idioma === "en" ? [d[2], d[1]] : [d[1], d[2]];
    const data = `${d[3]}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    if (soNaData && data !== soNaData) continue;
    const achado = { data, min: minutosDoDia(hora?.trim()) };
    if (soNaData || agoraMs === undefined || diaUTC(data) + (achado.min ?? 0) * 60000 >= agoraMs) return achado;
    primeira ||= achado;
  }
  return primeira;
}
function avisosNaHoraCerta(r, { agora, hoje, agenda, idioma }) {
  const agoraMin = minutosDoDia(String(agora).match(/(\d{1,2}:\d{2}\s*(?:[AaPp]\.?\s*[Mm]\.?)?)\s*$/)?.[1]);
  if (agoraMin === null || !/^\d{4}-\d{2}-\d{2}$/.test(hoje)) return r;
  const agoraMs = diaUTC(hoje) + agoraMin * 60000;
  for (const a of r.acoes || []) {
    if (a.avisoDaquiMin == null && !a.avisoHora) continue;
    const ev = a.data && a.hora ? { data: a.data, min: minutosDoDia(a.hora) } : horarioNaAgenda(agenda, a.eventoId, a.soNaData, idioma, agoraMs);
    if (ev && ev.min !== null) {
      const evMs = diaUTC(a.data || ev.data) + (a.hora ? minutosDoDia(a.hora) : ev.min) * 60000;
      const avisoMs = a.avisoDaquiMin != null ? agoraMs + a.avisoDaquiMin * 60000 : diaUTC(a.data || ev.data) + (minutosDoDia(a.avisoHora) ?? 0) * 60000;
      a.lembreteMin = Math.max(0, Math.round((evMs - avisoMs) / 60000));
    }
    delete a.avisoDaquiMin; delete a.avisoHora;
  }
  return r;
}
async function pensar(env, dados) {
  const r = await pensarUmaVez(env, dados);
  if (!confirmaSemAcao(r) && r.tipo !== "nao_entendi") return r;
  try {
    const r2 = await pensarUmaVez(env, { ...dados, model: "claude-sonnet-5-5" });
    if (!confirmaSemAcao(r2)) return r2;
  } catch (e) { console.error("Segunda tentativa falhou:", e.message); }
  return confirmaSemAcao(r) ? { tipo: "nao_entendi", resposta: dados.idioma === "en" ? "I didn't quite get that. Can you say it again?" : "Não entendi direito. Pode falar de novo?", acoes: [] } : r;
}
async function pensarUmaVez(env, { texto, agora, hoje, agenda, notas, avisoPadrao, idioma, model = MODELOS[0], extra = "" }) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const resp = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    // Sonnet 5.5 aceita o desvio automático para outro modelo em caso de recusa; o Haiku não
    ...(model === "claude-sonnet-5-5" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
    system: (idioma === "en" ? `${SISTEMA}\n\nIdioma desta pessoa: ela fala INGLÊS. Entenda o pedido em inglês e escreva títulos, anotações, hábitos e "resposta" em inglês natural. Na resposta em inglês, escreva horários como "4 PM", "4:30 PM", "noon".` : SISTEMA) + extra,
    messages: [{
      role: "user",
      content: `Agora: ${agora}\nAviso padrão desta pessoa: ${avisoPadrao} minutos antes\n\nDatas dos próximos dias:\n${proximosDias(hoje)}\n\nHora SEM período para hoje ou sem dia (use exatamente esta tabela; se a pessoa disser manhã/tarde/noite ou outro dia, ela não vale):\n${tabelaHoras(agora, hoje)}\n\nAgenda (próximas ocorrências, uma por linha: id | dia | hora | nome | repetição):\n${agenda}\n\nAnotações sem data (id | texto):\n${notas}\n\nA pessoa disse: "${texto}"`,
    }],
  });
  if (resp.stop_reason === "refusal") return { tipo: "nao_entendi", resposta: idioma === "en" ? "Sorry, I couldn't help with that." : "Desculpa, não consegui ajudar com isso.", acoes: [] };
  return avisosNaHoraCerta({ ...JSON.parse(resp.content.find((b) => b.type === "text").text), modelo: resp.model }, { agora, hoje, agenda, idioma });
}

// Áudio do WhatsApp: baixa da Meta e transforma em texto com o Whisper da Cloudflare
async function ouvirAudio(env, mediaId, idioma) {
  const auth = { Authorization: `Bearer ${env.WA_TOKEN}` };
  const info = await (await fetch(`${WA_API}${mediaId}`, { headers: auth })).json();
  if (!info.url) throw new Error("áudio sem endereço");
  const bytes = new Uint8Array(await (await fetch(info.url, { headers: auth })).arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) throw new Error("áudio grande demais");
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: btoa(bin), language: idioma === "en_US" ? "en" : "pt" });
  return (r.text || "").trim();
}

// Pedido escrito ou falado no WhatsApp: a Bee entende com a agenda que o app mandou, guarda as mudanças
// para o app aplicar e já agenda daqui o aviso do que foi criado
async function pedidoWhatsapp(env, avisos, lig, telefone, texto) {
  const tz = fusoOk(lig.tz || "America/Sao_Paulo"), idioma = lig.idioma === "en_US" ? "en_US" : "pt_BR";
  const agoraMs = Date.now(), rel = relogio(tz, agoraMs);
  const agoraTxt = `${new Date(agoraMs).toLocaleDateString(idioma === "en_US" ? "en-US" : "pt-BR", { timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })} ${rel.hora}`;
  const avisoPadrao = Number.isInteger(lig.lembrete) && lig.lembrete >= 0 ? lig.lembrete : 15;
  const r = await pensar(env, {
    texto: texto.slice(0, 600), agora: agoraTxt, hoje: rel.data, agenda: lig.agenda || "(vazia)", notas: lig.notas || "(nenhuma)", avisoPadrao, idioma: idioma === "en_US" ? "en" : "pt",
    extra: "\n\nEsta conversa é pelo WhatsApp. Escreva \"resposta\" curta e simpática, em texto simples, sem markdown.",
  });
  const acoes = r.tipo === "agir" && Array.isArray(r.acoes) ? r.acoes : [];
  const novos = [], remover = [];
  for (const [i, a] of acoes.entries()) {
    if (a.eventoId && (a.acao === "mudar" || a.acao === "desmarcar")) {
      const antigo = await avisos.avisoDoEvento(lig.uid, a.eventoId);
      remover.push(a.eventoId);
      if (a.acao === "mudar" && antigo && !a.soNaData && /^\d{2}:\d{2}$/.test(a.hora || "")) {
        const data = a.data || antigo.chave.split("|")[1];
        novos.push({ chave: `${a.eventoId}|${data}`, quando: instanteEm(tz, data, a.hora) - avisoPadrao * 60000, titulo: a.titulo || antigo.titulo, hora: horaFalada(a.hora, idioma), dia: diaFalado(tz, data, idioma) });
      }
    }
    if (a.acao === "criar" && a.data && /^\d{2}:\d{2}$/.test(a.hora || "")) {
      const min = a.lembreteMin === null ? null : Number.isInteger(a.lembreteMin) ? a.lembreteMin : avisoPadrao;
      if (min !== null) novos.push({ chave: `wa${agoraMs}-${i}|${a.data}`, quando: instanteEm(tz, a.data, a.hora) - min * 60000, titulo: a.titulo || (idioma === "en_US" ? "Appointment" : "Compromisso"), hora: horaFalada(a.hora, idioma), dia: diaFalado(tz, a.data, idioma) });
    }
  }
  if (acoes.length) await avisos.pedidoDoWhatsapp(lig.uid, { tipo: "acoes", acoes, frase: texto.slice(0, 600) }, novos.filter((n) => n.quando > agoraMs), remover);
  const fim = acoes.length ? (idioma === "en_US" ? "\n\nIt'll show up in Tap Bee when you open the app. 🐝" : "\n\nVai aparecer no Tap Bee quando você abrir o app. 🐝") : "";
  await textoWhatsapp(env, telefone, `${r.resposta || ""}${fim}`.trim());
}

async function whatsapp(req, env) {
  const caminho = new URL(req.url).pathname;
  if (caminho === "/whatsapp/estado") return estadoWhatsapp(req, env);
  if (caminho === "/whatsapp/modelos") return modelosWhatsapp(req, env);
  if (caminho === "/whatsapp/app") return whatsappDoApp(req, env);
  if (req.method === "GET") {
    const u = new URL(req.url).searchParams;
    if (u.get("hub.mode") === "subscribe" && env.WA_VERIFY_TOKEN && u.get("hub.verify_token") === env.WA_VERIFY_TOKEN) return new Response(u.get("hub.challenge") || "", { status: 200 });
    return new Response("não autorizado", { status: 403 });
  }
  if (req.method !== "POST") return new Response("use POST", { status: 405 });
  const corpo = await req.text();
  if (!(await assinaturaOk(req, corpo, env))) return new Response("assinatura inválida", { status: 401 });
  try {
    const msg = JSON.parse(corpo)?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg?.from) await tratarMensagem(env, msg);
  } catch (e) { console.error("WhatsApp: erro ao tratar mensagem", e.message); }
  return new Response("ok", { status: 200 });
}
async function tratarMensagem(env, msg) {
  const avisos = env.AVISOS.get(env.AVISOS.idFromName("avisos")), de = msg.from;
  const avisar = (tipo, idioma, nome) => textoWhatsapp(env, de, RESPOSTAS_WA[tipo][idioma === "en_US" ? "en_US" : "pt_BR"](nome));
  const lig = await avisos.ligacao(de);
  if (lig && !(await avisos.assinou(lig.uid))) return avisos.desligarSemAssinatura(lig.uid);
  // Botões do aviso
  const payload = msg.type === "button" ? msg.button?.payload : msg.type === "interactive" ? msg.interactive?.button_reply?.id : "";
  if (payload && /^(feito|adiar)\|/.test(payload)) {
    const [acao, ...resto] = payload.split("|"), r = await avisos.botao(de, acao, resto.join("|"));
    if (r.idioma === null) return avisar("outro", "pt_BR");
    return avisar(r.ok ? acao : "perdido", r.idioma);
  }
  let texto = msg.type === "text" ? msg.text?.body || "" : "";
  if (msg.type === "audio" && lig) {
    try { texto = await ouvirAudio(env, msg.audio.id, lig.idioma); } catch (e) { console.error("WhatsApp: áudio", e.message); }
    if (!texto) return avisar("audio", lig.idioma);
  }
  const r = await avisos.receber(de, texto);
  if (r.tipo === "ligado" && !(await avisos.assinou(r.uid, true))) { await avisos.sair(r.uid); return avisar("assine", r.idioma); }
  if (r.tipo !== "pedido") return avisar(r.tipo, r.idioma, r.nome);
  if (!texto.trim()) return avisar("outro", r.idioma);
  try { await pedidoWhatsapp(env, avisos, lig, de, texto); } catch (e) { console.error("WhatsApp: pedido", e.message); await avisar("erro", r.idioma); }
}

// O app liga o número, pergunta se já ligou, manda os próximos avisos, busca o que veio pelo WhatsApp e desliga
async function whatsappDoApp(req, env) {
  const origem = req.headers.get("Origin") || "";
  if (!ORIGENS.includes(origem)) return responder({ erro: "origem não permitida" }, 403, origem);
  if (req.method !== "POST") return responder({ erro: "use POST" }, 405, origem);
  let e;
  try { e = await req.json(); } catch { return responder({ erro: "JSON inválido" }, 400, origem); }
  if (!ID_APARELHO.test(e.uid || "")) return responder({ erro: "id inválido" }, 400, origem);
  const idioma = e.idioma === "en" ? "en_US" : "pt_BR", nome = String(e.nome || "").trim().slice(0, 30);
  const avisos = env.AVISOS.get(env.AVISOS.idFromName("avisos"));
  if (e.acao === "iniciar") {
    if (!/^([A-Z]{3,10}\d{2}|[A-Z0-9]{6})$/.test(e.codigo || "")) return responder({ erro: "código inválido" }, 400, origem);
    if (!(await avisos.assinou(e.uid, true))) return responder({ erro: "sem_assinatura" }, 402, origem);
    if (!(await avisos.iniciar(e.uid, e.codigo, idioma, nome))) return responder({ erro: "código em uso" }, 409, origem);
    return responder({ ok: true, numero: "5519990055701" }, 200, origem);
  }
  if (e.acao === "situacao") return responder(await avisos.situacao(e.uid), 200, origem);
  if (e.acao === "sair") { await avisos.sair(e.uid); return responder({ ok: true }, 200, origem); }
  if (e.acao === "pendentes") return responder({ itens: await avisos.pendentes(e.uid) }, 200, origem);
  if (e.acao === "confirmar") { await avisos.confirmar(e.uid, (Array.isArray(e.ids) ? e.ids : []).filter(Number.isInteger).slice(0, 100)); return responder({ ok: true }, 200, origem); }
  if (e.acao === "sincronizar") {
    const lista = (Array.isArray(e.avisos) ? e.avisos : []).slice(0, 60)
      .map((a) => ({ chave: String(a.chave || "").slice(0, 80), quando: +a.quando, titulo: String(a.titulo || "").trim().slice(0, 60), hora: String(a.hora || "").slice(0, 12), dia: String(a.dia || "").slice(0, 20) }))
      .filter((a) => a.chave && a.titulo && a.hora && Number.isFinite(a.quando));
    const extra = { tz: fusoOk(String(e.tz || "")), lembrete: Number.isInteger(e.lembretePadrao) ? e.lembretePadrao : 15, agenda: String(e.agenda || "").slice(0, 12000), notas: String(e.notas || "").slice(0, 4000) };
    return responder(await avisos.sincronizar(e.uid, lista, idioma, nome, extra), 200, origem);
  }
  return responder({ erro: "ação desconhecida" }, 400, origem);
}

export default {
  async fetch(req, env) {
    const origem = req.headers.get("Origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { headers: cabecalhos(origem) });
    if (new URL(req.url).pathname.startsWith("/whatsapp")) return whatsapp(req, env);
    if (new URL(req.url).pathname === "/funil") return funil(req, env, origem);
    if (new URL(req.url).pathname === "/convite") {
      if (!ORIGENS.includes(origem)) return responder({ erro: "origem não permitida" }, 403, origem);
      return convite(req, env, origem);
    }
    if (req.method !== "POST") return responder({ erro: "use POST" }, 405, origem);
    if (!ORIGENS.includes(origem)) return responder({ erro: "origem não permitida" }, 403, origem);

    let entrada;
    try { entrada = await req.json(); } catch { return responder({ erro: "JSON inválido" }, 400, origem); }
    const texto = String(entrada.texto || "").slice(0, 600).trim();
    if (!texto) return responder({ erro: "texto vazio" }, 400, origem);
    if (!(await dentroDoLimite(env, String(entrada.aparelho || ""), req.headers.get("CF-Connecting-IP") || "?"))) return responder({ erro: "limite diário" }, 429, origem);
    const agora = String(entrada.agora || "").slice(0, 80);
    const hoje = /^\d{4}-\d{2}-\d{2}$/.test(entrada.hoje) ? entrada.hoje : "";
    const agenda = String(entrada.agenda || "(vazia)").slice(0, 12000);
    const notas = String(entrada.notas || "(nenhuma)").slice(0, 4000);
    const avisoPadrao = Number.isInteger(entrada.lembretePadrao) && entrada.lembretePadrao >= 0 ? entrada.lembretePadrao : 15;
    const model = MODELOS.includes(entrada.modelo) ? entrada.modelo : MODELOS[0];

    try {
      return responder(await pensar(env, { texto, agora, hoje, agenda, notas, avisoPadrao, idioma: entrada.idioma, model }), 200, origem);
    } catch (e) {
      const status = e instanceof Anthropic.APIError ? e.status : 500;
      console.error("Erro ao chamar o Claude:", status, e.message);
      return responder({ erro: "falha na IA", status }, 502, origem);
    }
  },
};
