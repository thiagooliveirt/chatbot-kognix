require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const Redis = require('ioredis');

const app = express();
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });

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

const MEDIA_LIMIT  = 8;        // max fotos/audios processados pelo Gemini
const MEDIA_WINDOW = 60 * 30;  // por numero, em 30 minutos

async function withinMediaLimit(phone) {
  const key = `media:${phone}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, MEDIA_WINDOW);
  return count <= MEDIA_LIMIT;
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

MENSAGENS MULTIMODAIS:
- Mensagens que chegam como "[Imagem recebida] ..." ou "[Áudio transcrito] ..." são fotos e áudios que o cliente mandou, já descritos/transcritos pra você.
- Trate o conteúdo depois dos colchetes como se o cliente tivesse te mostrado ou contado aquilo diretamente. NUNCA repita os colchetes ou mencione "imagem recebida"/"áudio transcrito" pro cliente.
- Use a informação (foto de carro, conta de luz, documento, áudio) pra avançar o atendimento (ex: orçamento, qualificação), igual faria lendo ou ouvindo de verdade.

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

async function getMediaBase64(messageKey) {
  try {
    const response = await axios.post(
      `${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`,
      { message: { key: messageKey } },
      { headers: { apikey: EVOLUTION_KEY } }
    );
    return response.data;
  } catch (err) {
    console.error('[Erro ao baixar midia]', err.response?.data || err.message);
    return null;
  }
}

async function describeImage(base64, mimetype) {
  try {
    const result = await geminiModel.generateContent([
      { inlineData: { data: base64, mimeType: mimetype || 'image/jpeg' } },
      'Descreva objetivamente o que aparece nessa imagem, focando em qualquer informação útil para um agente de vendas: tipo de objeto/veículo/imóvel, estado de conservação, texto visível, valores, datas, dados de conta ou documento. Responda em português, em no máximo 3 frases.',
    ]);
    return result.response.text();
  } catch (err) {
    console.error('[Erro Gemini Vision]', err.message);
    return null;
  }
}

async function transcribeAudio(base64, mimetype) {
  try {
    const result = await geminiModel.generateContent([
      { inlineData: { data: base64, mimeType: mimetype || 'audio/ogg' } },
      'Transcreva fielmente o áudio a seguir em português. Responda APENAS com a transcrição, sem comentários nem aspas.',
    ]);
    return result.response.text();
  } catch (err) {
    console.error('[Erro Gemini audio]', err.message);
    return null;
  }
}

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
    const key = body.data.key;
    const jid = key.remoteJid;
    if (jid.includes('@g.us') || key.fromMe) return;

    // @lid: dump completo para encontrar o numero real no payload
    if (jid.includes('@lid')) {
      console.log('[lid] PAYLOAD COMPLETO:', JSON.stringify(body, null, 2));
    }

    let replyTo = jid;
    if (jid.includes('@lid')) {
      replyTo = key.senderPn
        ? `${key.senderPn}@s.whatsapp.net`
        : (key.remoteJidAlt || jid);
    }

    // chave estavel para Redis (historico/rate-limit/lead): usa o identificador recebido
    const phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '');

    const messageData = body.data.message;
    let text =
      messageData?.conversation ||
      messageData?.extendedTextMessage?.text ||
      null;

    if (!text && messageData?.imageMessage) {
      const caption = messageData.imageMessage.caption || '';
      if (!(await withinMediaLimit(phone))) {
        await sendWhatsApp(replyTo, 'Vi que você mandou várias fotos seguidas! Pra eu analisar com calma, manda uma de cada vez, com um intervalo curtinho entre elas 😊');
        return;
      }
      const media = await getMediaBase64(body.data.key);
      const description = media?.base64
        ? await describeImage(media.base64, messageData.imageMessage.mimetype)
        : null;
      if (description) {
        text = `[Imagem recebida${caption ? ` com legenda: "${caption}"` : ''}] ${description}`;
      } else {
        text = caption || '[O cliente enviou uma imagem, mas não consegui analisar o conteúdo agora]';
      }
    }

    if (!text && (messageData?.audioMessage || messageData?.pttMessage)) {
      if (!(await withinMediaLimit(phone))) {
        await sendWhatsApp(replyTo, 'Vi que você mandou vários áudios seguidos! Pra eu ouvir com calma, manda um de cada vez, com um intervalo curtinho entre eles 😊');
        return;
      }
      const media = await getMediaBase64(body.data.key);
      const mimetype = messageData.audioMessage?.mimetype || messageData.pttMessage?.mimetype;
      const transcript = media?.base64 ? await transcribeAudio(media.base64, mimetype) : null;
      if (transcript) {
        text = `[Áudio transcrito] ${transcript}`;
      } else {
        await sendWhatsApp(jid, 'Oi! Recebi seu áudio mas não consegui processar agora. Pode escrever a mensagem? 😊');
        return;
      }
    }

    if (!text) return;

    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${phone}: ${text}`);

    const reply = await processMessage(phone, text);
    console.log(`[Kognix → ${phone}]: ${reply}`);
    await sendWhatsApp(replyTo, reply);
  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'Kognix Bot online ✓', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kognix Bot rodando na porta ${PORT}`));
