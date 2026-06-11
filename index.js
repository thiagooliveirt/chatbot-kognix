require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const Redis = require('ioredis');

const app = express();
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EVOLUTION_URL      = process.env.EVOLUTION_API_URL;
const EVOLUTION_KEY      = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const NOTIFY_NUMBERS     = ['5521974056251']; // Thiago

const redis = new Redis(process.env.REDIS_URL);
redis.on('connect', () => console.log('Redis conectado ✓'));
redis.on('error',   (err) => console.error('Erro Redis:', err.message));

const TTL         = 60 * 60 * 24 * 7;
const MAX_HISTORY = 20;

async function getHistory(phone) {
  const data = await redis.get(`conv:${phone}`);
  return data ? JSON.parse(data) : [];
}

async function saveHistory(phone, history) {
  await redis.set(`conv:${phone}`, JSON.stringify(history), 'EX', TTL);
}

async function getLeadState(phone) {
  const data = await redis.get(`lead:${phone}`);
  return data ? JSON.parse(data) : { saved: false, notified: false };
}

async function saveLeadState(phone, state) {
  await redis.set(`lead:${phone}`, JSON.stringify(state), 'EX', TTL);
}

// ── SYSTEM PROMPT — Agente Coringa Kognix ─────────────────────
// TODO: substituir pelo prompt final do Gemini
const SYSTEM_PROMPT = `Você é o Agente Coringa da Kognix Solutions — uma IA de vendas e qualificação para WhatsApp.

A Kognix vende Agentes Autônomos de WhatsApp com IA real (não chatbot de menu) para clínicas, imobiliárias e concessionárias.

FORMATO DAS RESPOSTAS:
- NUNCA use asteriscos, underlines, markdown ou qualquer formatação especial
- Escreva em texto puro, como uma pessoa digitando no WhatsApp
- Use emojis com moderação

COMO SE COMPORTAR:
- Tom direto, consultivo e confiante
- Faça perguntas uma de cada vez
- Respostas curtas (máx 3 parágrafos)

FLUXO DE ATENDIMENTO:
1. Se apresente e pergunte o nome e o segmento do negócio
2. Identifique o problema principal (perda de leads, no-show, demora no atendimento)
3. Apresente o agente adequado ao segmento
4. Ofereça o teste gratuito: 7 dias ou 10 leads grátis

AGENTES DISPONÍVEIS:
- Agendador: clínicas e serviços — marca, remarca, confirma, mata no-show
- Qualificador: imóveis e veículos — separa curioso de comprador, entrega lead quente
- Orçamentista: engenharia e solar — lê foto/PDF e monta orçamento sozinho

PLANOS:
- Starter: R$ 300/mês + setup R$ 400
- Business: R$ 550/mês + setup R$ 800
- Enterprise: R$ 900/mês + setup R$ 1.200

REGRAS:
- NÃO feche contratos ou aceite pagamentos
- NÃO ofereça descontos
- Sempre conduza para o teste gratuito como próximo passo

Contato: WhatsApp (21) 99999-9999 | kognixsolutions.com.br`;

async function sendWhatsApp(jid, message) {
  try {
    await axios.post(
      `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      { number: jid, text: message },
      { headers: { apikey: EVOLUTION_KEY } }
    );
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err.response?.data || err.message);
  }
}

async function notifyTeam(phone, lead) {
  const msg = `🔔 Lead quente via Kognix!\n\nNome: ${lead.nome || 'Não informado'}\nSegmento: ${lead.segmento || 'Não informado'}\nInteresse: ${lead.interesse || 'Não informado'}\nWhatsApp: +${phone}\n\nResponda agora!`;
  for (const number of NOTIFY_NUMBERS) {
    await sendWhatsApp(`${number}@s.whatsapp.net`, msg);
  }
}

async function checkLeadQualification(history) {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `Analise a conversa e retorne APENAS JSON válido, sem markdown:
{"nome": string|null, "segmento": string|null, "interesse": string|null, "quente": boolean}
"quente" = true se pediu teste, preço ou demonstração.`,
      messages: history,
    });
    const raw = response.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[Erro qualificação]', err.message);
    return null;
  }
}

async function processMessage(phone, userMessage) {
  const history = await getHistory(phone);
  const state   = await getLeadState(phone);

  history.push({ role: 'user', content: userMessage });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const assistantMessage = response.content[0].text;
    history.push({ role: 'assistant', content: assistantMessage });
    await saveHistory(phone, history);

    if (history.length >= 4 && (!state.saved || !state.notified)) {
      const lead = await checkLeadQualification(history);
      if (lead?.nome && lead?.segmento) {
        if (lead.quente && !state.notified) {
          await notifyTeam(phone, lead);
          state.notified = true;
        }
        await saveLeadState(phone, state);
      }
    }

    return assistantMessage;
  } catch (err) {
    console.error('Erro na API Claude:', err.message);
    return 'Olá! Tive um pequeno problema técnico. Entre em contato pelo kognixsolutions.com.br 😊';
  }
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body?.data?.key?.remoteJid) return;
    const jid = body.data.key.remoteJid;
    if (jid.includes('@g.us') || body.data.key.fromMe) return;

    const messageData = body.data.message;
    const text =
      messageData?.conversation ||
      messageData?.extendedTextMessage?.text ||
      messageData?.imageMessage?.caption || null;

    if (!text) {
      if (messageData?.audioMessage || messageData?.pttMessage) {
        await sendWhatsApp(jid, 'Oi! Não consigo ouvir áudios, mas pode me escrever que te atendo na hora 😊');
      }
      return;
    }

    const phone = jid.replace('@s.whatsapp.net', '');
    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${phone}: ${text}`);

    const reply = await processMessage(phone, text);
    console.log(`[Kognix → ${phone}]: ${reply}`);
    await sendWhatsApp(jid, reply);
  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'Kognix Bot online ✓', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kognix Bot rodando na porta ${PORT}`));
