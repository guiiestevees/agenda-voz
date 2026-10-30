// Cérebro da Agenda por Voz: recebe a fala + a agenda da pessoa,
// pergunta ao Claude o que fazer e devolve as ações em JSON para o app aplicar.
import Anthropic from "@anthropic-ai/sdk";

const ORIGENS = ["https://guiiestevees.github.io", "http://localhost:8000", "http://127.0.0.1:8000"];

// Haiku é o padrão (rápido e barato). Sonnet fica liberado para comparar a qualidade.
const MODELOS = ["claude-haiku-5-5", "claude-sonnet-5-5"];

const SISTEMA = `Você é a secretária pessoal de uma agenda no iPhone, falando português do Brasil.
A pessoa fala com você por voz (o texto vem de um ditado, pode ter erros de transcrição, muletas e repetições).
Sua tarefa: entender o pedido e devolver as ações para o app executar.

tipo:
- "agir": a pessoa quer criar, mudar ou desmarcar compromissos, ou criar hábitos. Coloque em "acoes" UMA ação para CADA compromisso citado, na ordem em que foram falados. Ex.: "médico terça às 4 e dentista quinta às 10" → duas ações "criar".
- "responder": a pessoa quer saber algo da agenda ("o que tenho amanhã?", "que horas estou livre na sexta?"). Responda em "resposta" e deixe "acoes" vazia.
- "nao_entendi": o pedido não tem nada a ver com agenda ou está incompreensível. "acoes" vazia.

Cada ação:
- acao "criar": novo compromisso. Preencha titulo, data, hora, lembreteMin, repetir e diasSemana; eventoId e soNaData = null.
- acao "mudar": alterar um compromisso que JÁ existe na agenda. Preencha eventoId e só os campos que mudam; os outros ficam null (repetir "manter").
- acao "desmarcar": cancelar um compromisso que já existe. Preencha eventoId; o resto null (repetir "manter").
- acao "habito": criar um HÁBITO, algo para fazer com frequência SEM horário marcado ("beber 2 litros de água todo dia", "ler 10 páginas", "meditar de segunda a sexta", "treinar 3 vezes por semana"). Preencha titulo (curto, ex.: "Beber 2L de água"), diasSemana ([] = todos os dias) e emoji (um emoji que combine). Se tiver horário marcado ("academia toda segunda às 7"), NÃO é hábito: é "criar" com repetição.

Regras:
- titulo: só o nome do compromisso, curto e com inicial maiúscula ("Médico", "Academia", "Reunião com o João", "Tomar remédio"). Nunca inclua data, hora, lembrete ou palavras como "tenho", "marca", "me lembra".
- data no formato AAAA-MM-DD e hora HH:MM (24h), no fuso da pessoa. Use a lista de datas abaixo para saber o dia certo de "terça", "amanhã" etc. "às 4" sem período quase sempre é 16:00; de 8 a 11 sem período é manhã. Sem dia → hoje, ou amanhã se o horário de hoje já passou. Sem hora → 09:00. Se a pessoa falar vários compromissos e só disser o dia no primeiro, os seguintes são no mesmo dia.
- lembreteMin: minutos de antecedência do aviso. "me lembre 15 min antes" → 15; "me lembra de tomar remédio às 8" → 0; "1 dia antes" → 1440. Se a pessoa não falar nada sobre aviso ao criar, use 15; para aniversário, use 0. Em "mudar", null = não mexer e -1 = tirar o aviso.
- repetir: "nenhuma", "diaria", "semanal", "mensal" ou "anual". Para semanal, diasSemana com os dias (0=domingo, 1=segunda … 6=sábado), ex.: "toda segunda e quarta" → [1,3]; "de segunda a sexta" → [1,2,3,4,5]. Aniversário → "anual". Nos outros casos diasSemana = [].
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
          acao: { type: "string", enum: ["criar", "mudar", "desmarcar", "habito"] },
          emoji: nulo("string"),
          eventoId: nulo("string"),
          soNaData: nulo("string"),
          titulo: nulo("string"),
          data: nulo("string"),
          hora: nulo("string"),
          lembreteMin: nulo("integer"),
          repetir: { type: "string", enum: ["nenhuma", "diaria", "semanal", "mensal", "anual", "manter"] },
          diasSemana: { type: "array", items: { type: "integer" } },
        },
        required: ["acao", "emoji", "eventoId", "soNaData", "titulo", "data", "hora", "lembreteMin", "repetir", "diasSemana"],
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  };
}
const responder = (corpo, status, origem) => new Response(JSON.stringify(corpo), { status, headers: cabecalhos(origem) });

export default {
  async fetch(req, env) {
    const origem = req.headers.get("Origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { headers: cabecalhos(origem) });
    if (req.method !== "POST") return responder({ erro: "use POST" }, 405, origem);
    if (!ORIGENS.includes(origem)) return responder({ erro: "origem não permitida" }, 403, origem);

    let entrada;
    try { entrada = await req.json(); } catch { return responder({ erro: "JSON inválido" }, 400, origem); }
    const texto = String(entrada.texto || "").slice(0, 600).trim();
    if (!texto) return responder({ erro: "texto vazio" }, 400, origem);
    const agora = String(entrada.agora || "").slice(0, 80);
    const hoje = /^\d{4}-\d{2}-\d{2}$/.test(entrada.hoje) ? entrada.hoje : "";
    const agenda = String(entrada.agenda || "(vazia)").slice(0, 12000);
    const model = MODELOS.includes(entrada.modelo) ? entrada.modelo : MODELOS[0];

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const resp = await client.beta.messages.create({
        model,
        max_tokens: 4000,
        // Sonnet 5.5 aceita o desvio automático para outro modelo em caso de recusa; o Haiku não
        ...(model === "claude-sonnet-5-5" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
        output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
        system: SISTEMA,
        messages: [{
          role: "user",
          content: `Agora: ${agora}\n\nDatas dos próximos dias:\n${proximosDias(hoje)}\n\nAgenda (próximas ocorrências, uma por linha: id | dia | hora | nome | repetição):\n${agenda}\n\nA pessoa disse: "${texto}"`,
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
