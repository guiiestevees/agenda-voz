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
- titulo: só o nome do compromisso, curto e com inicial maiúscula ("Médico", "Academia", "Reunião com o João", "Tomar remédio"). Nunca inclua data, hora, lembrete ou palavras como "tenho", "marca", "me lembra".
- data no formato AAAA-MM-DD e hora HH:MM (24h), no fuso da pessoa. Use a lista de datas abaixo para saber o dia certo de "terça", "amanhã" etc. "às 4" sem período quase sempre é 16:00; de 8 a 11 sem período é manhã. Com hora mas sem dia → hoje, ou amanhã se o horário de hoje já passou. Com dia mas sem hora → 09:00. Sem dia E sem hora, é uma tarefa para lembrar → "anotar" (a não ser que a pessoa peça claramente para marcar agora). Se a pessoa falar vários compromissos e só disser o dia no primeiro, os seguintes são no mesmo dia.
- lembreteMin: minutos de antecedência do aviso. "me lembre 15 min antes" → 15; "me lembra de tomar remédio às 8" → 0; "1 dia antes" → 1440. Se a pessoa não falar nada sobre aviso ao criar, use o aviso padrão informado na mensagem; para aniversário, use 0. Em "mudar", null = não mexer e -1 = tirar o aviso.
- repetir: "nenhuma", "diaria", "semanal", "mensal" ou "anual". Para semanal, diasSemana com os dias (0=domingo, 1=segunda … 6=sábado), ex.: "toda segunda e quarta" → [1,3]; "de segunda a sexta" → [1,2,3,4,5]. Aniversário → "anual". Nos outros casos diasSemana = [].
- notaId: só em "agendar" e "tirar_nota", escolhido na lista de anotações pelo texto; nas outras ações, null.
- Para mudar/desmarcar, escolha o eventoId na agenda pelo nome e pela data mencionados. Se o compromisso se repete e a pessoa fala de um dia só ("desmarca a academia de amanhã"), preencha soNaData com a data daquela ocorrência; se fala da série toda ("cancela a academia"), soNaData = null.
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
          repetir: { type: "string", enum: ["nenhuma", "diaria", "semanal", "mensal", "anual", "manter"] },
          diasSemana: { type: "array", items: { type: "integer" } },
        },
        required: ["acao", "emoji", "eventoId", "notaId", "soNaData", "titulo", "data", "hora", "lembreteMin", "repetir", "diasSemana"],
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
    return `${i === 0 ? "hoje" : i === 1 ? "amanhã" : nomes[d.getUTCDay()]}: ${d.toISOString().slice(0, 10)} (${nomes[d.getUTCDay()]})`;
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
// Avisos da Bee: a Meta só deixa a empresa puxar conversa com textos aprovados; o servidor sorteia um a cada aviso
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
const EXEMPLO_BEE = { pt_BR: ["Gui", "Pagar o boleto", "10:00"], en_US: ["Gui", "Pay the bill", "10:00 AM"] };
// Só para nós: GET mostra a situação dos modelos na Meta; POST manda os que faltam para aprovação
async function modelosWhatsapp(req, env) {
  if (!env.FUNIL_CHAVE || req.headers.get("x-chave") !== env.FUNIL_CHAVE) return new Response("não autorizado", { status: 401 });
  const auth = { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" };
  const lista = await (await fetch(`${WA_API}${WA_CONTA}/message_templates?fields=name,language,status,category&limit=100`, { headers: auth })).json();
  if (req.method === "GET") return new Response(JSON.stringify(lista), { headers: { "Content-Type": "application/json" } });
  const existe = new Set((lista.data || []).map((m) => `${m.name}|${m.language}`));
  const resultado = [];
  for (const [idioma, textos] of Object.entries(MODELOS_BEE)) {
    for (const [i, texto] of textos.entries()) {
      const name = `bee_lembrete_${i + 1}`;
      if (existe.has(`${name}|${idioma}`)) { resultado.push({ name, idioma, ja: true }); continue; }
      const [nome, compromisso, hora] = EXEMPLO_BEE[idioma];
      const r = await fetch(`${WA_API}${WA_CONTA}/message_templates`, {
        method: "POST", headers: auth,
        body: JSON.stringify({
          name, language: idioma, category: "UTILITY", parameter_format: "NAMED",
          components: [{ type: "BODY", text: texto, example: { body_text_named_params: [
            { param_name: "nome", example: nome }, { param_name: "compromisso", example: compromisso }, { param_name: "hora", example: hora },
          ] } }],
        }),
      });
      resultado.push({ name, idioma, status: r.status, resposta: await r.json() });
    }
  }
  return new Response(JSON.stringify(resultado), { headers: { "Content-Type": "application/json" } });
}
async function whatsapp(req, env) {
  if (new URL(req.url).pathname === "/whatsapp/estado") return estadoWhatsapp(req, env);
  if (new URL(req.url).pathname === "/whatsapp/modelos") return modelosWhatsapp(req, env);
  if (req.method === "GET") {
    const u = new URL(req.url).searchParams;
    if (u.get("hub.mode") === "subscribe" && env.WA_VERIFY_TOKEN && u.get("hub.verify_token") === env.WA_VERIFY_TOKEN) return new Response(u.get("hub.challenge") || "", { status: 200 });
    return new Response("não autorizado", { status: 403 });
  }
  if (req.method !== "POST") return new Response("use POST", { status: 405 });
  const corpo = await req.text();
  if (!(await assinaturaOk(req, corpo, env))) return new Response("assinatura inválida", { status: 401 });
  // Por enquanto só confirma o recebimento; marcar compromissos pelo WhatsApp vem depois
  try {
    const mudanca = JSON.parse(corpo)?.entry?.[0]?.changes?.[0]?.value;
    if (mudanca?.messages?.length) console.log("WhatsApp: mensagem recebida", mudanca.messages[0].type);
  } catch {}
  return new Response("ok", { status: 200 });
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

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const resp = await client.beta.messages.create({
        model,
        max_tokens: 4000,
        // Sonnet 5.5 aceita o desvio automático para outro modelo em caso de recusa; o Haiku não
        ...(model === "claude-sonnet-5-5" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
        output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
        system: entrada.idioma === "en" ? `${SISTEMA}\n\nIdioma desta pessoa: ela fala INGLÊS. Entenda o pedido em inglês e escreva títulos, anotações, hábitos e "resposta" em inglês natural.` : SISTEMA,
        messages: [{
          role: "user",
          content: `Agora: ${agora}\nAviso padrão desta pessoa: ${avisoPadrao} minutos antes\n\nDatas dos próximos dias:\n${proximosDias(hoje)}\n\nAgenda (próximas ocorrências, uma por linha: id | dia | hora | nome | repetição):\n${agenda}\n\nAnotações sem data (id | texto):\n${notas}\n\nA pessoa disse: "${texto}"`,
        }],
      });
      if (resp.stop_reason === "refusal") return responder({ tipo: "nao_entendi", resposta: "Desculpa, não consegui ajudar com isso.", acoes: [] }, 200, origem);
      const bloco = resp.content.find((b) => b.type === "text");
      return responder({ ...JSON.parse(bloco.text), modelo: resp.model }, 200, origem);
    } catch (e) {
      const status = e instanceof Anthropic.APIError ? e.status : 500;
      console.error("Erro ao chamar o Claude:", status, e.message);
      return responder({ erro: "falha na IA", status }, 502, origem);
    }
  },
};
