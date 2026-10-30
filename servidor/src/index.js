// Cérebro da Agenda por Voz: recebe a fala + a agenda da pessoa,
// pergunta ao Claude o que fazer e devolve UMA ação em JSON para o app aplicar.
import Anthropic from "@anthropic-ai/sdk";

const ORIGENS = ["https://guiiestevees.github.io", "http://localhost:8000", "http://127.0.0.1:8000"];

const SISTEMA = `Você é a secretária pessoal de uma agenda no iPhone, falando português do Brasil.
A pessoa fala com você por voz (o texto vem de um ditado, pode ter erros de transcrição, muletas e repetições).
Sua tarefa: entender o pedido e devolver UMA ação para o app executar.

Ações:
- "criar": novo compromisso. Preencha titulo, data, hora, lembreteMin, repetir e diasSemana.
- "mudar": alterar um compromisso que JÁ existe na agenda (horário, dia, nome, lembrete, repetição). Preencha eventoId e só os campos que mudam; os outros ficam null.
- "desmarcar": cancelar um compromisso que já existe. Preencha eventoId.
- "perguntar": a pessoa quer saber algo da agenda ("o que tenho amanhã?", "que horas estou livre na sexta?"). Responda em "resposta" e não altere nada.
- "nao_entendi": o pedido não tem nada a ver com agenda ou está incompreensível.

Regras:
- titulo: só o nome do compromisso, curto e com inicial maiúscula ("Médico", "Academia", "Reunião com o João", "Tomar remédio"). Nunca inclua data, hora, lembrete ou palavras como "tenho", "marca", "me lembra".
- data no formato AAAA-MM-DD e hora HH:MM (24h), no fuso da pessoa. "às 4" sem período quase sempre é 16:00; de 8 a 11 sem período é manhã. Sem dia → hoje, ou amanhã se o horário de hoje já passou. Sem hora → 09:00.
- lembreteMin: minutos de antecedência do aviso. "me lembre 15 min antes" → 15; "me lembra de tomar remédio às 8" → 0; "1 dia antes" → 1440. Se a pessoa não falar nada sobre aviso ao criar, use 15. Em "mudar", null = não mexer e -1 = tirar o aviso.
- repetir: "nenhuma", "diaria", "semanal", "mensal" ou "anual". Para semanal, diasSemana com os dias (0=domingo, 1=segunda … 6=sábado), ex.: "toda segunda e quarta" → [1,3]. Aniversário → "anual". Nos outros casos diasSemana = []. Em "mudar", use repetir "manter" para não mexer na repetição.
- Para mudar/desmarcar, escolha o eventoId na lista da agenda pelo nome e pela data mencionados. Se o compromisso se repete e a pessoa fala de um dia só ("desmarca a academia de amanhã"), preencha soNaData com a data daquela ocorrência; se fala da série toda ("cancela a academia"), soNaData = null.
- Se não achar o compromisso para mudar/desmarcar, use "perguntar" e diga isso em "resposta".
- resposta: uma frase curta e simpática, como uma secretária falaria em voz alta, confirmando o que foi feito ou respondendo a pergunta. Ex.: "Anotado: médico terça às 16h, te aviso 15 minutos antes." Fale horários como "16h" ou "16h30" e dias como "terça" ou "amanhã". Sem emojis.`;

const nulo = (tipo) => ({ type: [tipo, "null"] });
const ESQUEMA = {
  type: "object",
  properties: {
    acao: { type: "string", enum: ["criar", "mudar", "desmarcar", "perguntar", "nao_entendi"] },
    resposta: { type: "string" },
    eventoId: nulo("string"),
    soNaData: nulo("string"),
    titulo: nulo("string"),
    data: nulo("string"),
    hora: nulo("string"),
    lembreteMin: nulo("integer"),
    repetir: { type: "string", enum: ["nenhuma", "diaria", "semanal", "mensal", "anual", "manter"] },
    diasSemana: { type: "array", items: { type: "integer" } },
  },
  required: ["acao", "resposta", "eventoId", "soNaData", "titulo", "data", "hora", "lembreteMin", "repetir", "diasSemana"],
  additionalProperties: false,
};

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
    const agenda = String(entrada.agenda || "(vazia)").slice(0, 12000);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const resp = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
        system: SISTEMA,
        messages: [{
          role: "user",
          content: `Agora: ${agora}\n\nAgenda (próximas ocorrências, uma por linha: id | dia | hora | nome | repetição):\n${agenda}\n\nA pessoa disse: "${texto}"`,
        }],
      });
      if (resp.stop_reason === "refusal") return responder({ acao: "nao_entendi", resposta: "Desculpa, não consegui ajudar com isso." }, 200, origem);
      const bloco = resp.content.find((b) => b.type === "text");
      return responder(JSON.parse(bloco.text), 200, origem);
    } catch (e) {
      const status = e instanceof Anthropic.APIError ? e.status : 500;
      console.error("Erro ao chamar o Claude:", status, e.message);
      return responder({ erro: "falha na IA", status }, 502, origem);
    }
  },
};
