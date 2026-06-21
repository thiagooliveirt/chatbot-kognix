require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Redis = require('ioredis');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  initAuthCreds,
  BufferJSON,
  proto,
  Browsers,
} = require('@whiskeysockets/baileys');

const logger = pino({ level: 'silent' });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });

const NOTIFY_NUMBERS = ['5521974056251']; // Thiago

// Token que protege as rotas administrativas (/qr e /reset).
// Defina ADMIN_TOKEN no Railway e no .env. Sem ele, essas rotas ficam bloqueadas.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
function isAuthorized(req) {
  return Boolean(ADMIN_TOKEN) && req.query.token === ADMIN_TOKEN;
}

const redis = new Redis(process.env.REDIS_URL);
redis.on('connect', () => console.log('Redis conectado ✓'));
redis.on('error',   (err) => console.error('Erro Redis:', err.message));

const TTL         = 60 * 60 * 24 * 7;
const MAX_HISTORY = 20;

// ── Auth state persistido no Redis (Railway tem disco efemero) ──────
async function useRedisAuthState(prefix = 'wa:kognix') {
  const writeData = (key, data) =>
    redis.set(`${prefix}:${key}`, JSON.stringify(data, BufferJSON.replacer));
  const readData = async (key) => {
    const data = await redis.get(`${prefix}:${key}`);
    return data ? JSON.parse(data, BufferJSON.reviver) : null;
  };
  const removeData = (key) => redis.del(`${prefix}:${key}`);

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    clearAll: async () => {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
    },
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
  };
}

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

const TEXT_LIMIT  = 40;        // max mensagens de texto processadas pela IA
const TEXT_WINDOW = 60 * 15;   // por numero, em 15 minutos (anti-flood / anti-custo)

async function textMsgCount(phone) {
  const key = `txt:${phone}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, TEXT_WINDOW);
  return count;
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

REGRAS:
- NÃO feche contratos ou aceite pagamentos
- NÃO ofereça descontos
- Sempre conduza para o teste gratuito como próximo passo

Contato: kognixsolutions.com.br`;

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

// ── WhatsApp via Baileys direto ────────────────────────────────
let sock = null;
let lastQR = null;
let connectionStatus = 'iniciando';

async function downloadMedia(msg) {
  try {
    const buffer = await downloadMediaMessage(
      msg, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    return buffer.toString('base64');
  } catch (err) {
    console.error('[Erro download midia]', err.message);
    return null;
  }
}

async function sendWhatsApp(jid, message) {
  try {
    await sock.sendMessage(jid, { text: message });
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err.message);
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

async function handleMessage(msg) {
  try {
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid.includes('@g.us') || jid === 'status@broadcast') return;

    // chave estavel para Redis (historico/rate-limit/lead)
    const phone = jid.replace(/@.*/, '');

    const m = msg.message;
    let text =
      m.conversation ||
      m.extendedTextMessage?.text ||
      null;

    if (!text && m.imageMessage) {
      const caption = m.imageMessage.caption || '';
      if (!(await withinMediaLimit(phone))) {
        await sendWhatsApp(jid, 'Vi que você mandou várias fotos seguidas! Pra eu analisar com calma, manda uma de cada vez, com um intervalo curtinho entre elas 😊');
        return;
      }
      const base64 = await downloadMedia(msg);
      const description = base64
        ? await describeImage(base64, m.imageMessage.mimetype)
        : null;
      if (description) {
        text = `[Imagem recebida${caption ? ` com legenda: "${caption}"` : ''}] ${description}`;
      } else {
        text = caption || '[O cliente enviou uma imagem, mas não consegui analisar o conteúdo agora]';
      }
    }

    if (!text && (m.audioMessage || m.pttMessage)) {
      if (!(await withinMediaLimit(phone))) {
        await sendWhatsApp(jid, 'Vi que você mandou vários áudios seguidos! Pra eu ouvir com calma, manda um de cada vez, com um intervalo curtinho entre eles 😊');
        return;
      }
      const base64 = await downloadMedia(msg);
      const mimetype = m.audioMessage?.mimetype || m.pttMessage?.mimetype;
      const transcript = base64 ? await transcribeAudio(base64, mimetype) : null;
      if (transcript) {
        text = `[Áudio transcrito] ${transcript}`;
      } else {
        await sendWhatsApp(jid, 'Oi! Recebi seu áudio mas não consegui processar agora. Pode escrever a mensagem? 😊');
        return;
      }
    }

    if (!text) return;

    // Rate-limit de texto: protege contra flood e estouro de custo de API.
    const txtCount = await textMsgCount(phone);
    if (txtCount > TEXT_LIMIT) {
      if (txtCount === TEXT_LIMIT + 1) {
        await sendWhatsApp(jid, 'Recebi muitas mensagens em sequência! Vou retomar nosso papo daqui a pouco. Se for urgente, fala com a gente em kognixsolutions.com.br 😊');
      }
      console.warn(`[rate-limit] ${phone}: ${txtCount} msgs em ${TEXT_WINDOW / 60}min — ignorando`);
      return;
    }

    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${phone} (${msg.pushName}): ${text}`);

    await sock.sendPresenceUpdate('composing', jid);
    const reply = await processMessage(phone, text);
    console.log(`[Kognix → ${phone}]: ${reply}`);
    await sendWhatsApp(jid, reply);
  } catch (err) {
    console.error('Erro ao processar mensagem:', err.message);
  }
}

async function startSock() {
  const { state, saveCreds } = await useRedisAuthState();
  const { version } = await fetchLatestBaileysVersion();
  console.log('Baileys WA version:', version.join('.'));

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.appropriate('Chrome'),
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      lastQR = qr;
      connectionStatus = 'aguardando_qr';
      console.log('>>> QR gerado. Acesse /qr para escanear.');
    }
    if (connection === 'open') {
      lastQR = null;
      connectionStatus = 'conectado';
      console.log('WhatsApp conectado ✓');
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      connectionStatus = 'desconectado';
      console.log('Conexao fechada. Status:', statusCode, '| loggedOut:', loggedOut);
      if (!loggedOut) {
        setTimeout(startSock, 3000);
      } else {
        console.log('Deslogado pelo WhatsApp. Acesse /reset para limpar e gerar novo QR.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) await handleMessage(msg);
  });
}

// ── Servidor HTTP: QR + health ─────────────────────────────────
const app = express();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/', (req, res) => res.json({
  status: 'Kognix Bot online ✓',
  whatsapp: connectionStatus,
  timestamp: new Date().toISOString(),
}));

app.get('/qr', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).send(page('Acesso negado',
      '<p>Token invalido ou ausente. Acesse com ?token=SEU_ADMIN_TOKEN</p>'));
  }
  if (connectionStatus === 'conectado') {
    return res.send(page('WhatsApp conectado ✓', '<p style="color:#10b981;font-size:20px">Robô conectado e operando.</p>'));
  }
  if (!lastQR) {
    return res.send(page('Aguardando QR...', '<p>Gerando QR code. Atualize em alguns segundos.</p>'));
  }
  const dataUrl = await QRCode.toDataURL(lastQR, { width: 320, margin: 2 });
  res.send(page('Conecte o WhatsApp do robô',
    `<img src="${dataUrl}" style="border-radius:12px"/>
     <p style="margin-top:24px">No celular do robô: WhatsApp → Aparelhos conectados → Conectar aparelho</p>
     <p style="opacity:.5;font-size:13px">A página atualiza sozinha se o QR expirar</p>`));
});

app.get('/reset', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).send(page('Acesso negado',
      '<p>Token invalido ou ausente. Acesse com ?token=SEU_ADMIN_TOKEN</p>'));
  }
  try {
    const { clearAll } = await useRedisAuthState();
    await clearAll();
    res.send(page('Credenciais limpas', '<p>Reiniciando para gerar novo QR. Aguarde e acesse /qr.</p>'));
    setTimeout(() => process.exit(0), 1500); // Railway reinicia o processo
  } catch (err) {
    console.error('[reset] erro:', err.message);
    res.status(500).send(page('Erro', '<p>Nao foi possivel resetar agora.</p>'));
  }
});

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <title>Kognix Bot</title></head>
  <body style="background:#080c14;color:#fff;font-family:system-ui,sans-serif;text-align:center;padding:48px 20px">
  <h2 style="color:#00d4ff;margin-bottom:28px">${title}</h2>${body}</body></html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Kognix Bot rodando na porta ${PORT}`);
  startSock();
});
