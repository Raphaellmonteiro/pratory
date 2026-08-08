// src/routes/kiosk.ts — quiosque de ponto, KDS público e cardápio público
import { Router, type Response } from 'express';
import path from 'path';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { q1, qAll, qRun, qInsert } from '../db';
import crypto from 'node:crypto';
import { JWT_SECRET, publicRateLimit, requireTrustedBrowserOrigin } from '../middleware';
import { resolveRequiresPreparation } from '../utils/preparation';
import { notifyTenantOrderStreams, setupSseStream } from '../sse';
import { parseBodyOrReply, replyZod400ErrorKey } from '../validation/zodHttp';
import { loginBodySchema } from '../validation/schemas/publicForms';
import { normalizeProductPhotoPublicUrl } from '../utils/productPhotoUrl';
import { sanitizeFuncionarioRowForClient, verifyEmployeePinAndRehashIfLegacy } from '../utils/funcionarioPin';
import { emitWhatsAppOrderStatusEvent } from '../services/whatsAppEventsService';

const TZ = 'America/Sao_Paulo';

function isCanceledOrder(order?: { status?: string | null; cancelado_at?: string | null } | null) {
  return Boolean(order?.cancelado_at) || String(order?.status || '').trim().toLowerCase() === 'cancelado';
}

function buildActiveKdsOrderClause(alias?: string) {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}cancelado_at IS NULL AND COALESCE(${prefix}status,'') NOT IN ('Entregue','cancelado','Cancelado','ConcluÃ­do','Concluido','concluido')`;
}

function buildOperationalKdsOrderClause(alias?: string) {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}cancelado_at IS NULL AND LOWER(COALESCE(${prefix}status,'')) <> 'entregue' AND LOWER(COALESCE(${prefix}status,'')) <> 'cancelado' AND LOWER(COALESCE(${prefix}status,'')) NOT LIKE 'conclu%'`;
}

function getPublicSlugOrReject(res: Response, slug: unknown) {
  if (typeof slug !== 'string') {
    res.status(400).json({ error: 'Slug inválido' });
    return null;
  }

  const normalized = slug.trim();
  if (!normalized || normalized.length > 120 || !/^[a-z0-9_-]+$/i.test(normalized)) {
    res.status(400).json({ error: 'Slug inválido' });
    return null;
  }

  return normalized;
}

function isDatabaseConnectivityError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '').toUpperCase()
      : '';

  return (
    [
      'connection terminated due to connection timeout',
      'connection terminated unexpectedly',
      'terminating connection',
      'connection timeout',
      'timeout expired',
      'could not connect',
      'econnrefused',
      'etimedout',
      'socket hang up',
    ].some((snippet) => message.includes(snippet)) ||
    ['08000', '08001', '08003', '08006', '57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
  );
}

function handlePublicRouteError(res: Response, route: string, slug: string | undefined, error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? 'Erro desconhecido');
  const stack = error instanceof Error ? error.stack : undefined;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : undefined;
  const isDbUnavailable = isDatabaseConnectivityError(error);

  console.error(`[kiosk] ${route} failed`, {
    slug,
    code,
    message,
    stack,
  });

  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(isDbUnavailable ? 503 : 500).json({
    error: isDbUnavailable ? 'Serviço temporariamente indisponível. Tente novamente.' : 'Erro interno do servidor',
  });
}

async function syncMesaOrderVisibility(
  tenantId: number,
  mesa: { id: number; numero: number },
  comandaId: number,
  itens: Array<{ product_id: number; quantity: number; price_at_time: number }>
) {
  const mesaLabel = `Mesa ${mesa.numero}`;
  let createdNewOrder = false;
  let pedido = await q1(
    `SELECT id
     FROM pedidos
     WHERE tenant_id=?
       AND observation=?
       AND ${buildOperationalKdsOrderClause()}
     ORDER BY id DESC
     LIMIT 1`,
    [tenantId, mesaLabel]
  );

  if (!pedido) {
    const dateObj = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
    const y = String(dateObj.getFullYear()).slice(-2);
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    const orderDate = `${y}${m}${d}`;
    const maxOrder = await q1('SELECT MAX(id) as maxId FROM pedidos WHERE tenant_id=?', [tenantId]);
    const orderNumber = `${orderDate}-${tenantId}-KDS-${((maxOrder?.maxId || 0) + 1).toString().padStart(4, '0')}-${Date.now()}`;

    const pedidoId = await qInsert(
      `INSERT INTO pedidos
        (order_number,total_amount,observation,tenant_id,senha_pedido,tipo_retirada,canal,status,mesa_id,comanda_id)
       VALUES (?,?,?,?,?,'mesa','mesa','Aguardando confirmação',?,?)`,
      [orderNumber, 0, mesaLabel, tenantId, mesa.numero, mesa.id, comandaId]
    );

    pedido = { id: pedidoId };
    createdNewOrder = true;
  }

  let totalDelta = 0;

  for (const item of itens) {
    const quantity = Number(item.quantity) || 0;
    const priceAtTime = Number(item.price_at_time) || 0;
    if (quantity <= 0) continue;

    const existingItem = await q1(
      'SELECT id FROM itens_pedido WHERE order_id=? AND product_id=? AND tenant_id=?',
      [pedido.id, item.product_id, tenantId]
    );

    if (existingItem) {
      await qRun(
        'UPDATE itens_pedido SET quantity=quantity+?, price_at_time=? WHERE id=? AND tenant_id=?',
        [quantity, priceAtTime, existingItem.id, tenantId]
      );
    } else {
      await qRun(
        "INSERT INTO itens_pedido (order_id,product_id,quantity,type,price_at_time,tenant_id) VALUES (?,?,?,'Mesa',?,?)",
        [pedido.id, item.product_id, quantity, priceAtTime, tenantId]
      );
    }

    totalDelta += quantity * priceAtTime;
  }

  if (totalDelta > 0) {
    await qRun(
      `UPDATE pedidos
       SET total_amount=COALESCE(total_amount, 0)+?,
           mesa_id=COALESCE(mesa_id, ?),
           comanda_id=COALESCE(comanda_id, ?)
       WHERE id=? AND tenant_id=?`,
      [totalDelta, mesa.id, comandaId, pedido.id, tenantId]
    );
  }

  const oid = Number(pedido.id);
  if (createdNewOrder) {
    notifyTenantOrderStreams(tenantId, 'new', { orderId: oid });
  } else if (totalDelta > 0) {
    notifyTenantOrderStreams(tenantId, 'status', { orderId: oid });
  }
}

export function createKioskRouter() {
  const router = Router();
  const PIPELINE_KDS = ['Criado','Em Preparo','Pronto','Entregue'];
  const requireBrowserOrigin = requireTrustedBrowserOrigin({ allowMissing: false });

  // ── Token de acesso para telas operacionais (KDS / Ponto) ─────────────────
  /**
   * Gera um token HMAC-SHA256 deterministico para o par (slug, purpose).
   * O token deve ser gerado pelo backend autenticado e enviado ao frontend.
   * purpose: 'kds' | 'ponto'
   */
  function generateKioskAccessToken(slug: string, purpose: 'kds' | 'ponto'): string {
    const secret = process.env.KIOSK_TOKEN_SECRET || JWT_SECRET;
    return crypto.createHmac('sha256', secret).update(`${purpose}:${slug}`).digest('hex');
  }

  /**
   * Middleware que exige o header X-Kiosk-Token correto para telas operacionais.
   * O token é obtido via rota autenticada (/api/kiosk-token) e armazenado no frontend.
   */
  function requireKioskToken(purpose: 'kds' | 'ponto') {
    return (req: any, res: any, next: any) => {
      const secret = process.env.KIOSK_TOKEN_SECRET || JWT_SECRET;
      const slug = req.params.slug as string | undefined;
      if (!slug) return res.status(400).json({ error: 'Slug ausente' });
      const expected = crypto.createHmac('sha256', secret).update(`${purpose}:${slug}`).digest('hex');
      const provided = String(req.headers['x-kiosk-token'] || req.query['kiosk_token'] || '').trim();
      if (!provided) return res.status(401).json({ error: 'Token de acesso obrigatório. Acesse pelo painel.' });
      // Comparação segura contra timing attacks
      const expectedBuf = Buffer.from(expected, 'hex');
      const providedBuf = Buffer.alloc(expectedBuf.length);
      Buffer.from(provided.slice(0, expectedBuf.length * 2), 'hex').copy(providedBuf);
      if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
        return res.status(403).json({ error: 'Token de acesso inválido ou expirado. Acesse pelo painel.' });
      }
      next();
    };
  }



  // ── Página HTML do quiosque de ponto ──────────────────────────────────────
  router.get('/kiosk/ponto/:slug', (req, res) => {
    const slug = req.params.slug;
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
    res.setHeader('Pragma','no-cache');
    res.send(`<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Bater Ponto — Pratory</title>
<script src="https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#09090b;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
.clock{font-size:clamp(48px,10vw,96px);font-weight:900;letter-spacing:-2px;font-variant-numeric:tabular-nums;line-height:1}
.card{background:#18181b;border:1px solid #27272a;border-radius:24px;padding:32px;width:100%;max-width:420px;margin-top:28px;box-shadow:0 25px 60px rgba(0,0,0,.5)}
.btn{width:100%;height:52px;border-radius:16px;border:none;font-size:15px;font-weight:700;cursor:pointer;transition:.15s;display:flex;align-items:center;justify-content:center;gap:10px;margin-top:10px}
.btn-primary{background:#fff;color:#09090b}.btn-primary:hover{background:#e4e4e7}
.btn-ghost{background:transparent;color:#71717a;border:1px solid #27272a}.btn-ghost:hover{border-color:#52525b;color:#a1a1aa}
.btn-green{background:#16a34a;color:#fff}.btn-green:hover{background:#15803d}
.btn-red{background:#dc2626;color:#fff}.btn-red:hover{background:#b91c1c}
.btn:disabled{opacity:.35;cursor:not-allowed}
input{width:100%;padding:14px 16px;background:#09090b;border:1px solid #27272a;border-radius:12px;color:#fff;font-size:15px;margin-bottom:10px;outline:none}
input:focus{border-color:#52525b}
label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#71717a;display:block;margin-bottom:6px}
.status{text-align:center;padding:12px;border-radius:12px;font-size:14px;font-weight:700;margin-top:10px}
.status-ok{background:#14532d;color:#86efac}
.status-err{background:#450a0a;color:#fca5a5}
.status-warn{background:#451a03;color:#fdba74}
video,canvas{border-radius:16px;width:100%;max-height:240px;object-fit:cover}
.tab{display:flex;gap:8px;margin-bottom:20px}
.tab-btn{flex:1;padding:10px;border-radius:12px;border:1px solid #27272a;background:transparent;color:#71717a;font-size:13px;font-weight:700;cursor:pointer;transition:.15s}
.tab-btn.active{background:#fff;color:#09090b;border-color:#fff}
.espelho-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-top:10px}
.espelho-dia{border-radius:8px;padding:6px 2px;text-align:center;font-size:10px;font-weight:700}
.dia-trab{background:#14532d;color:#86efac}
.dia-falta{background:#450a0a;color:#fca5a5}
.dia-folga{background:#1e3a5f;color:#93c5fd}
.dia-hoje{outline:2px solid #fbbf24}
.dia-vazio{background:#18181b;color:#3f3f46}
</style></head><body>
<div class="clock" id="clock">00:00:00</div>
<div class="card" id="main">
  <div id="tela-login">
    <p style="text-align:center;font-size:16px;font-weight:700;margin-bottom:20px">🕐 Quiosque de Ponto</p>
    <label>Usuário</label>
    <input id="inp-user" placeholder="seu.usuario" autocomplete="username"/>
    <label>Senha</label>
    <input id="inp-pass" type="password" placeholder="••••••••" autocomplete="current-password"/>
    <button class="btn btn-primary" onclick="login()">Entrar</button>
    <div id="login-status" class="status" style="display:none"></div>
  </div>

  <div id="tela-func" style="display:none">
    <p id="func-nome" style="text-align:center;font-size:18px;font-weight:900;margin-bottom:4px"></p>
    <p id="func-cargo" style="text-align:center;font-size:12px;color:#71717a;margin-bottom:16px"></p>
    <div class="tab">
      <button class="tab-btn active" onclick="setAba('ponto')" id="tab-ponto">📸 Bater Ponto</button>
      <button class="tab-btn" onclick="setAba('espelho')" id="tab-espelho">📅 Meu Espelho</button>
    </div>

    <div id="aba-ponto">
      <div id="tipo-banner" style="display:none;border-radius:16px;padding:18px 12px;text-align:center;margin-bottom:16px;transition:.3s">
        <div id="tipo-emoji" style="font-size:40px;line-height:1;margin-bottom:6px"></div>
        <div id="tipo-label" style="font-size:22px;font-weight:900;letter-spacing:.05em"></div>
        <div id="tipo-sub" style="font-size:12px;margin-top:4px;opacity:.75"></div>
      </div>
      <div id="cam-wrap" style="display:none;margin-bottom:12px">
        <video id="video" autoplay muted playsinline></video>
        <canvas id="overlay" style="display:none"></canvas>
      </div>
      <button class="btn btn-green" id="btn-reconhecer" onclick="confirmarERegistrar()" style="display:none">📸 Reconhecer Rosto e Bater Ponto</button>
      <div id="wrap-cadastro" style="display:none">
        <div style="background:#1c1917;border:1px solid #44403c;border-radius:16px;padding:16px;margin-bottom:10px;text-align:center">
          <p style="font-size:13px;font-weight:700;color:#fbbf24;margin-bottom:6px">⚠️ Rosto não cadastrado</p>
          <p style="font-size:12px;color:#a1a1aa;margin-bottom:12px">Posicione seu rosto na câmera para cadastrar o reconhecimento facial.</p>
          <button class="btn btn-primary" onclick="cadastrarRosto()" style="height:44px;font-size:13px">📷 Cadastrar Meu Rosto</button>
        </div>
      </div>
      <div id="ponto-status" class="status" style="display:none"></div>
    </div>

    <div id="aba-espelho" style="display:none">
      <p id="esp-resumo" style="text-align:center;font-size:12px;color:#a1a1aa;margin-bottom:12px"></p>
      <div class="espelho-grid" id="esp-headers"></div>
      <div class="espelho-grid" id="esp-grid"></div>
    </div>

    <button class="btn btn-ghost" onclick="sair()" style="margin-top:16px">← Sair</button>
  </div>
</div>

<div id="modal-confirm" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:999;display:none;align-items:center;justify-content:center;padding:24px">
  <div style="background:#18181b;border:1px solid #27272a;border-radius:24px;padding:32px;width:100%;max-width:360px;text-align:center">
    <div id="mc-emoji" style="font-size:56px;line-height:1;margin-bottom:12px"></div>
    <div id="mc-tipo" style="font-size:26px;font-weight:900;margin-bottom:6px"></div>
    <div id="mc-nome" style="font-size:14px;color:#a1a1aa;margin-bottom:4px"></div>
    <div id="mc-hora" style="font-size:13px;color:#71717a;margin-bottom:24px"></div>
    <p style="font-size:13px;color:#a1a1aa;margin-bottom:20px">Confirma o registro de ponto?</p>
    <div style="display:flex;gap:10px">
      <button class="btn btn-ghost" style="flex:1;height:48px" onclick="fecharModal()">✕ Cancelar</button>
      <button class="btn btn-primary" id="mc-btn-confirm" style="flex:1;height:48px;font-size:15px" onclick="executarRegistro()">✓ Confirmar</button>
    </div>
  </div>
</div>

<script>
const slug='${slug}';
let funcAtual=null;
let modelsCarregados=false;
let stream=null;
function tick(){const n=new Date();document.getElementById('clock').textContent=n.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
tick();setInterval(tick,1000);
function showStatus(id,msg,tipo){const el=document.getElementById(id);el.textContent=msg;el.className='status status-'+(tipo||'ok');el.style.display='block';}
function hideStatus(id){document.getElementById(id).style.display='none';}
async function login(){
  const user=document.getElementById('inp-user').value.trim();
  const pass=document.getElementById('inp-pass').value;
  if(!user||!pass){showStatus('login-status','Preencha usuário e senha','err');return;}
  showStatus('login-status','Verificando...','warn');
  try{
    const r=await fetch('/public/ponto/'+slug+'/login-func',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user,password:pass})});
    const d=await r.json();
    if(!r.ok){showStatus('login-status',d.error||'Erro de login','err');return;}
    funcAtual=d.funcionario;
    hideStatus('login-status');
    document.getElementById('tela-login').style.display='none';
    document.getElementById('tela-func').style.display='block';
    document.getElementById('func-nome').textContent=funcAtual.nome;
    document.getElementById('func-cargo').textContent=funcAtual.cargo;
    if(funcAtual.face_descriptor&&funcAtual.face_descriptor.length>0){
      document.getElementById('btn-reconhecer').style.display='flex';
      document.getElementById('wrap-cadastro').style.display='none';
    } else {
      document.getElementById('btn-reconhecer').style.display='none';
      document.getElementById('wrap-cadastro').style.display='block';
    }
    await carregarProximoTipo();
    await carregarModels();
  }catch(e){showStatus('login-status','Erro de conexão','err');}
}
let proximoTipoAtual = 'entrada';
let metodoAtual = null;
async function cadastrarRosto(){
  if(!modelsCarregados){showStatus('ponto-status','⏳ Carregando IA facial...','warn');await carregarModels();if(!modelsCarregados){showStatus('ponto-status','❌ IA indisponível.','err');return;}hideStatus('ponto-status');}
  showStatus('ponto-status','📷 Abrindo câmera para cadastro...','warn');
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}});
    const video=document.getElementById('video');video.srcObject=stream;document.getElementById('cam-wrap').style.display='block';
    await new Promise(r=>{video.onloadedmetadata=r;});await video.play();
    for(let i=3;i>0;i--){showStatus('ponto-status','📷 Posicione o rosto... '+i+'s','warn');await new Promise(r=>setTimeout(r,1000));}
    showStatus('ponto-status','🔄 Capturando rosto...','warn');
    const opts=new faceapi.TinyFaceDetectorOptions({inputSize:416,scoreThreshold:0.4});let det=null;
    for(let t=1;t<=5;t++){showStatus('ponto-status','🔄 Detectando... ('+t+'/5)','warn');await new Promise(r=>setTimeout(r,800));det=await faceapi.detectSingleFace(video,opts).withFaceLandmarks().withFaceDescriptor();if(det)break;}
    pararCamera();
    if(!det){showStatus('ponto-status','❌ Rosto não detectado. Tente novamente com boa iluminação.','err');return;}
    const descriptor=Array.from(det.descriptor);
    const r=await fetch('/public/ponto/'+slug+'/save-face',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({func_id:funcAtual.id,descriptor})});
    const d=await r.json();
    if(d.success){funcAtual.face_descriptor=descriptor;document.getElementById('wrap-cadastro').style.display='none';document.getElementById('btn-reconhecer').style.display='flex';showStatus('ponto-status','✅ Rosto cadastrado com sucesso!','ok');}
    else showStatus('ponto-status','❌ Erro ao salvar: '+(d.error||'Tente novamente'),'err');
  }catch(e){pararCamera();showStatus('ponto-status','❌ Erro câmera: '+e.message,'err');}
}
async function carregarProximoTipo(){
  try{const r=await fetch('/public/ponto/'+slug+'/proximo-tipo/'+funcAtual.id);const d=await r.json();proximoTipoAtual=d.completo?'completo':d.tipo;atualizarBanner();const btn=document.getElementById('btn-reconhecer');if(btn)btn.disabled=d.completo;}catch{}
}
function atualizarBanner(){
  const banner=document.getElementById('tipo-banner');const emoji=document.getElementById('tipo-emoji');const label=document.getElementById('tipo-label');const sub=document.getElementById('tipo-sub');
  banner.style.display='block';
  if(proximoTipoAtual==='completo'){banner.style.background='#14532d';banner.style.border='2px solid #16a34a';emoji.textContent='✅';label.textContent='PONTO COMPLETO';sub.textContent='Entrada e saída já registradas hoje';}
  else if(proximoTipoAtual==='entrada'){banner.style.background='#052e16';banner.style.border='2px solid #16a34a';emoji.textContent='⬆️';label.textContent='REGISTRAR ENTRADA';label.style.color='#86efac';sub.textContent='Você ainda não bateu o ponto de entrada hoje';}
  else{banner.style.background='#450a0a';banner.style.border='2px solid #dc2626';emoji.textContent='⬇️';label.textContent='REGISTRAR SAÍDA';label.style.color='#fca5a5';sub.textContent='Entrada já registrada — batendo saída agora';}
}
async function carregarModels(){
  if(modelsCarregados)return;
  const btn=document.getElementById('btn-reconhecer');if(btn){btn.textContent='⏳ Carregando IA facial...';btn.disabled=true;}
  try{const CDN='https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model';await faceapi.nets.tinyFaceDetector.loadFromUri(CDN);await faceapi.nets.faceLandmark68Net.loadFromUri(CDN);await faceapi.nets.faceRecognitionNet.loadFromUri(CDN);modelsCarregados=true;if(btn){btn.textContent='📸 Reconhecer Rosto e Bater Ponto';btn.disabled=false;}}
  catch(e){console.warn('face-api models não carregados:',e);if(btn){btn.textContent='❌ IA indisponível (use PIN)';btn.disabled=true;}}
}
async function iniciarReconhecimento(){
  if(!modelsCarregados){showStatus('ponto-status','Modelos de IA ainda carregando, aguarde...','warn');return;}
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}});
    const video=document.getElementById('video');video.srcObject=stream;document.getElementById('cam-wrap').style.display='block';document.getElementById('btn-reconhecer').disabled=true;
    await new Promise(r=>{video.onloadedmetadata=r;});await video.play();
    for(let i=3;i>0;i--){document.getElementById('btn-reconhecer').textContent='📷 Posicione o rosto... '+i+'s';await new Promise(r=>setTimeout(r,1000));}
    document.getElementById('btn-reconhecer').textContent='🔄 Analisando rosto...';
    const opts=new faceapi.TinyFaceDetectorOptions({inputSize:416,scoreThreshold:0.4});let det=null;
    for(let tentativa=1;tentativa<=5;tentativa++){document.getElementById('btn-reconhecer').textContent='🔄 Detectando... ('+tentativa+'/5)';await new Promise(r=>setTimeout(r,800));det=await faceapi.detectSingleFace(video,opts).withFaceLandmarks().withFaceDescriptor();if(det)break;}
    pararCamera();
    if(!det){showStatus('ponto-status','Rosto não detectado após 5 tentativas. Verifique a iluminação ou use PIN.','err');resetBtnFace();return;}
    const salvo=new Float32Array(funcAtual.face_descriptor);const dist=faceapi.euclideanDistance(det.descriptor,salvo);
    if(dist>0.55){showStatus('ponto-status','Rosto não reconhecido. Use PIN ou recadastre o rosto.','err');resetBtnFace();return;}
    resetBtnFace();mostrarModalConfirmacao();
  }catch(e){pararCamera();showStatus('ponto-status','Erro câmera: '+e.message+'. Verifique permissões e use PIN.','err');resetBtnFace();}
}
function pararCamera(){if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}document.getElementById('cam-wrap').style.display='none';}
function resetBtnFace(){const btn=document.getElementById('btn-reconhecer');btn.textContent='📸 Reconhecer Rosto e Bater Ponto';btn.disabled=false;}
async function confirmarERegistrar(){
  if(proximoTipoAtual==='completo')return;metodoAtual='face';
  if(!modelsCarregados){showStatus('ponto-status','⏳ Carregando IA facial...','warn');await carregarModels();if(!modelsCarregados){showStatus('ponto-status','❌ IA indisponível. Contate o administrador.','err');metodoAtual=null;return;}hideStatus('ponto-status');}
  await iniciarReconhecimento();
}
function mostrarModalConfirmacao(){
  const isEntrada=proximoTipoAtual==='entrada';
  document.getElementById('mc-emoji').textContent=isEntrada?'⬆️':'⬇️';
  document.getElementById('mc-tipo').textContent=isEntrada?'ENTRADA':'SAÍDA';
  document.getElementById('mc-tipo').style.color=isEntrada?'#86efac':'#fca5a5';
  document.getElementById('mc-nome').textContent=funcAtual.nome+' — '+funcAtual.cargo;
  const agora=new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  document.getElementById('mc-hora').textContent='Horário: '+agora;
  const btnConfirm=document.getElementById('mc-btn-confirm');
  btnConfirm.style.background=isEntrada?'#16a34a':'#dc2626';
  btnConfirm.textContent=isEntrada?'⬆️ Confirmar ENTRADA':'⬇️ Confirmar SAÍDA';
  document.getElementById('modal-confirm').style.display='flex';
}
function fecharModal(){document.getElementById('modal-confirm').style.display='none';metodoAtual=null;}
async function executarRegistro(){fecharModal();await registrarPonto('face','');}
async function registrarPonto(metodo,pin){
  try{
    const r=await fetch('/public/ponto/'+slug+'/registrar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({func_id:funcAtual.id,pin:pin||'',metodo})});
    const d=await r.json();
    if(d.success){const tipoLabel=d.tipo==='entrada'?'ENTRADA ⬆️':'SAÍDA ⬇️';showStatus('ponto-status','✅ '+tipoLabel+' registrada às '+d.hora,'ok');await carregarProximoTipo();}
    else showStatus('ponto-status',d.error||'Erro ao registrar','err');
    resetBtnFace();
  }catch(e){showStatus('ponto-status','Erro de conexão','err');resetBtnFace();}
}
function setAba(aba){
  document.getElementById('aba-ponto').style.display=aba==='ponto'?'block':'none';
  document.getElementById('aba-espelho').style.display=aba==='espelho'?'block':'none';
  document.getElementById('tab-ponto').className='tab-btn'+(aba==='ponto'?' active':'');
  document.getElementById('tab-espelho').className='tab-btn'+(aba==='espelho'?' active':'');
  if(aba==='espelho')carregarEspelho();
}
async function carregarEspelho(){
  const now=new Date();
  try{
    const r=await fetch('/public/ponto/'+slug+'/espelho/'+funcAtual.id+'?month='+(now.getMonth()+1)+'&year='+now.getFullYear());
    const d=await r.json();const res=d.resumo;
    document.getElementById('esp-resumo').textContent='Trabalhados: '+res.diasTrabalhados+' | Faltas: '+res.totalFaltas+' | Atraso: '+res.totalAtrasoMin+'min';
    const heads=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    document.getElementById('esp-headers').innerHTML=heads.map(h=>'<div class="espelho-dia" style="color:#52525b">'+h+'</div>').join('');
    const hoje=now.toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
    const primeiro=d.dias[0];let grid='';
    for(let i=0;i<primeiro.diaSemana;i++)grid+='<div></div>';
    for(const dia of d.dias){
      let cls='espelho-dia dia-vazio';
      if(dia.status==='trabalhado')cls='espelho-dia dia-trab';
      else if(dia.status==='falta')cls='espelho-dia dia-falta';
      else if(dia.status==='folga'||dia.status==='atestado')cls='espelho-dia dia-folga';
      if(dia.data===hoje)cls+=' dia-hoje';
      const ent=dia.entrada?dia.entrada.slice(0,5):'';const sai=dia.saida?dia.saida.slice(0,5):'';
      grid+='<div class="'+cls+'" title="'+dia.data+(ent?' E:'+ent:'')+(sai?' S:'+sai:'')+'" >'+dia.dia+'</div>';
    }
    document.getElementById('esp-grid').innerHTML=grid;
  }catch(e){document.getElementById('esp-resumo').textContent='Erro ao carregar espelho';}
}
function sair(){
  funcAtual=null;proximoTipoAtual='entrada';metodoAtual=null;
  pararCamera();fecharModal();
  document.getElementById('tela-func').style.display='none';
  document.getElementById('tela-login').style.display='block';
  document.getElementById('inp-user').value='';document.getElementById('inp-pass').value='';
  document.getElementById('ponto-status').style.display='none';setAba('ponto');
}
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&document.getElementById('tela-login').style.display!=='none')login();});
</script></body></html>`);
  });

  // ── Rate limiters ─────────────────────────────────────────────────────────
  const kioskRateLimit = rateLimit({ windowMs:60000, max:300, standardHeaders:true, legacyHeaders:false, message:{error:'Muitas requisições. Aguarde um momento.'} });
  const loginKioskLimit = rateLimit({ windowMs:60000, max:30, standardHeaders:true, legacyHeaders:false, message:{error:'Muitas tentativas. Aguarde 1 minuto.'}, skipSuccessfulRequests:true });
  const kdsAdvanceLimit = rateLimit({ windowMs:60000, max:120, message:{error:'Muitas requisições ao KDS. Aguarde.'} });
  router.use('/public/ponto', kioskRateLimit);
  router.use('/public/kds',   kioskRateLimit);

  // ── API pública do quiosque ───────────────────────────────────────────────
  router.post('/public/ponto/:slug/login-func', loginKioskLimit, requireBrowserOrigin, async (req, res) => {
    const slug = getPublicSlugOrReject(res, req.params.slug);
    if (!slug) return;

    try {
      const body = parseBodyOrReply(res, loginBodySchema, req.body, replyZod400ErrorKey);
      if (!body) return;
      const { username, password } = body;
      const tenant = await q1('SELECT id FROM clientes WHERE usuario=?', [slug]);
      if (!tenant) return res.status(404).json({ error:'Estabelecimento não encontrado' });
      const user = await q1('SELECT * FROM usuarios WHERE username=? AND cliente_id=? AND ativo=1', [username, tenant.id]);
      if (!user) return res.status(401).json({ error:'Usuário não encontrado' });
      let ok = false;
      if (user.password?.startsWith('$2')) { try { ok = bcrypt.compareSync(password, user.password); } catch {} }
      if (!ok) return res.status(401).json({ error:'Senha incorreta' });
      const func = await q1("SELECT id,nome,cargo,foto_url,face_descriptor FROM funcionarios WHERE tenant_id=? AND nome=? AND status='ativo'", [tenant.id, user.nome]);
      if (!func) return res.status(404).json({ error:'Funcionário não encontrado no RH' });
      res.json({ funcionario:{ id:func.id, nome:func.nome, cargo:func.cargo, foto_url:func.foto_url||null, face_descriptor:func.face_descriptor?JSON.parse(func.face_descriptor):null } });
    } catch (error) {
      handlePublicRouteError(res, 'POST /public/ponto/:slug/login-func', slug, error);
    }
  });

  router.post('/public/ponto/:slug/save-face', requireBrowserOrigin, requireKioskToken('ponto'), async (req, res) => {
    const slug = getPublicSlugOrReject(res, req.params.slug);
    if (!slug) return;

    try {
      const { func_id, descriptor } = req.body;
      if (!func_id||!descriptor||!Array.isArray(descriptor)) return res.status(400).json({ error:'Dados inválidos' });
      const tenant = await q1('SELECT id FROM clientes WHERE usuario=?', [slug]);
      if (!tenant) return res.status(404).json({ error:'Não encontrado' });
      await qRun('UPDATE funcionarios SET face_descriptor=? WHERE id=? AND tenant_id=?', [JSON.stringify(descriptor), func_id, tenant.id]);
      res.json({ success:true });
    } catch (error) {
      handlePublicRouteError(res, 'POST /public/ponto/:slug/save-face', slug, error);
    }
  });

  router.get('/public/ponto/:slug/proximo-tipo/:func_id', requireKioskToken('ponto'), async (req, res) => {
    const slug = getPublicSlugOrReject(res, req.params.slug);
    if (!slug) return;

    try {
      const tenant = await q1('SELECT id FROM clientes WHERE usuario=?', [slug]);
      if (!tenant) return res.status(404).json({ error:'Não encontrado' });
      const data = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      const hoje = await qAll('SELECT tipo FROM func_pontos WHERE funcionario_id=? AND tenant_id=? AND data=? ORDER BY id ASC', [req.params.func_id, tenant.id, data]);
      const temEnt = hoje.some((p:any)=>p.tipo==='entrada');
      const temSai = hoje.some((p:any)=>p.tipo==='saida');
      res.json({ tipo: temEnt&&!temSai ? 'saida' : 'entrada', completo: temEnt&&temSai });
    } catch (error) {
      handlePublicRouteError(res, 'GET /public/ponto/:slug/proximo-tipo/:func_id', slug, error);
    }
  });

  router.get('/public/ponto/:slug/espelho/:func_id', requireKioskToken('ponto'), async (req, res) => {
    const slug = getPublicSlugOrReject(res, req.params.slug);
    if (!slug) return;

    try {
      const tenant = await q1('SELECT id FROM clientes WHERE usuario=?', [slug]);
      if (!tenant) return res.status(404).json({ error:'Não encontrado' });
      const func = await q1('SELECT * FROM funcionarios WHERE id=? AND tenant_id=?', [req.params.func_id, tenant.id]);
      if (!func) return res.status(404).json({ error:'Funcionário não encontrado' });
      const mm = String(req.query.month||new Date().getMonth()+1).padStart(2,'0');
      const yy = String(req.query.year||new Date().getFullYear());
      const hoje = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      const [pontos, eventos] = await Promise.all([
        qAll(`SELECT * FROM func_pontos WHERE funcionario_id=? AND tenant_id=? AND TO_CHAR(data::date,'MM')=? AND TO_CHAR(data::date,'YYYY')=? ORDER BY data,hora`, [func.id, tenant.id, mm, yy]),
        qAll(`SELECT * FROM func_eventos WHERE funcionario_id=? AND tenant_id=? AND TO_CHAR(data::date,'MM')=? AND TO_CHAR(data::date,'YYYY')=? ORDER BY data`, [func.id, tenant.id, mm, yy]),
      ]);
      const pbd: Record<string,any[]>={}, ebd: Record<string,any[]>={};
      for (const p of pontos) { if(!pbd[p.data])pbd[p.data]=[]; pbd[p.data].push(p); }
      for (const e of eventos) { if(!ebd[e.data])ebd[e.data]=[]; ebd[e.data].push(e); }
      const diasNoMes = new Date(Number(yy),Number(mm),0).getDate();
      const diasSemana = (func.dias_semana||'1,2,3,4,5').split(',').map(Number);
      const tolerancia = func.tolerancia_minutos||10;
      const cargaHoras = func.carga_horaria||8;
      const horEnt = func.horario_entrada||'08:00';
      let tFaltas=0,tAtrasos=0,dTrab=0,dFolga=0,dAtestado=0;
      const dias: any[] = [];
      for (let d=1;d<=diasNoMes;d++) {
        const ds=`${yy}-${mm}-${String(d).padStart(2,'0')}`;
        const diaSem=new Date(ds+'T12:00:00').getDay();
        const isExp=diasSemana.includes(diaSem);
        const evts=ebd[ds]||[], pts=pbd[ds]||[];
        const ent=pts.find((p:any)=>p.tipo==='entrada'), sai=pts.find((p:any)=>p.tipo==='saida');
        let status='sem_expediente', am=0;
        if (ds>hoje||(func.data_admissao&&ds<func.data_admissao)) status='sem_expediente';
        else if (evts.some((e:any)=>e.tipo==='folga')) { status='folga'; dFolga++; }
        else if (evts.some((e:any)=>e.tipo==='atestado')) { status='atestado'; dAtestado++; }
        else if (isExp) {
          if (ent) {
            status='trabalhado'; dTrab++;
            const [eh,em2]=horEnt.split(':').map(Number);
            const lim=eh*60+em2+tolerancia;
            const [rh,rm]=ent.hora.split(':').map(Number);
            const entM=rh*60+rm;
            if (entM>lim) { am=entM-(eh*60+em2); tAtrasos+=am; }
          } else { status='falta'; tFaltas++; }
        }
        dias.push({data:ds,dia:d,diaSemana:diaSem,isExpediente:isExp&&ds<=hoje,status,entrada:ent?.hora,saida:sai?.hora,atrasoMin:am,eventos:evts});
      }
      const vd=func.salario_base/(func.dias_trabalho_mes||26);
      res.json({ dias, resumo:{diasTrabalhados:dTrab,totalFaltas:tFaltas,diasFolga:dFolga,diasAtestado:dAtestado,totalAtrasoMin:tAtrasos,descontoFaltas:tFaltas*vd,descontoAtrasos:(tAtrasos/60)*(vd/cargaHoras),totalDescontos:(tFaltas*vd)+((tAtrasos/60)*(vd/cargaHoras))} });
    } catch (error) {
      handlePublicRouteError(res, 'GET /public/ponto/:slug/espelho/:func_id', slug, error);
    }
  });

  router.get('/public/ponto/:slug', async (req, res) => {
    const slug = getPublicSlugOrReject(res, req.params.slug);
    if (!slug) return;

    try {
      const tenant = await q1('SELECT id,nome_estabelecimento FROM clientes WHERE usuario=?', [slug]);
      if (!tenant) return res.status(404).json({ error:'Não encontrado' });
      const funcs = await qAll("SELECT id,nome,cargo,pin,foto_url FROM funcionarios WHERE tenant_id=? AND status='ativo' ORDER BY nome", [tenant.id]);
      res.json({
        estabelecimento: tenant.nome_estabelecimento,
        funcionarios: funcs.map((r) => sanitizeFuncionarioRowForClient(r as Record<string, unknown>)),
      });
    } catch (error) {
      handlePublicRouteError(res, 'GET /public/ponto/:slug', slug, error);
    }
  });

  router.post('/public/ponto/:slug/registrar', requireBrowserOrigin, requireKioskToken('ponto'), async (req, res) => {
    const slug = getPublicSlugOrReject(res, req.params.slug);
    if (!slug) return;

    try {
      const { pin, func_id, metodo } = req.body;
      const tenant = await q1('SELECT id FROM clientes WHERE usuario=?', [slug]);
      if (!tenant) return res.status(404).json({ error:'Não encontrado' });
      const func = await q1("SELECT * FROM funcionarios WHERE id=? AND tenant_id=? AND status='ativo'", [func_id, tenant.id]);
      if (!func) return res.status(404).json({ error:'Funcionário não encontrado' });
      if (metodo !== 'face') {
        const stored = func.pin as string | null | undefined;
        if (stored && String(stored).trim()) {
          const ok = await verifyEmployeePinAndRehashIfLegacy(stored, String(pin ?? ''), Number(func.id), tenant.id);
          if (!ok) return res.status(401).json({ success: false, error: 'PIN incorreto' });
        }
      }
      const now = new Date();
      const data = now.toLocaleDateString('en-CA', { timeZone: TZ });
      const hora = now.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone: TZ });
      const hoje = await qAll('SELECT tipo FROM func_pontos WHERE funcionario_id=? AND tenant_id=? AND data=? ORDER BY id ASC', [func.id, tenant.id, data]);
      const temEnt = hoje.some((p:any)=>p.tipo==='entrada');
      const temSai = hoje.some((p:any)=>p.tipo==='saida');
      if (temEnt&&temSai) return res.status(409).json({ success:false, error:'Ponto completo para hoje.' });
      const tipo = temEnt ? 'saida' : 'entrada';
      if (tipo === 'entrada' && func.horario_entrada) {
        const [hh,mm2] = func.horario_entrada.split(':').map(Number);
        const agoraMin = now.getHours()*60+now.getMinutes();
        const entMin = hh*60+mm2;
        const minutosAntes = 10;
        if (agoraMin < entMin - minutosAntes) {
          const falta = entMin - minutosAntes - agoraMin;
          return res.status(403).json({ success:false, error:`Muito cedo para bater ponto. Aguarde ${falta} minuto(s) (abertura às ${func.horario_entrada}).` });
        }
      }
      await qRun('INSERT INTO func_pontos (tenant_id,funcionario_id,data,hora,tipo,ip) VALUES (?,?,?,?,?,?)', [tenant.id, func.id, data, hora, tipo, 'kiosk']);
      res.json({ success:true, tipo, hora, nome:func.nome });
    } catch (error) {
      handlePublicRouteError(res, 'POST /public/ponto/:slug/registrar', slug, error);
    }
  });

  // ── KDS público ───────────────────────────────────────────────────────────
  router.get('/public/kds/:slug', async (req, res) => {
    const slug = getPublicSlugOrReject(res, req.params.slug);
    if (!slug) return;

    try {
      const tenant = await q1('SELECT id,nome_estabelecimento FROM clientes WHERE usuario=?', [slug]);
      if (!tenant) return res.status(404).json({ error:'Restaurante não encontrado', slug });

      // 1ª query: pedidos ainda ativos (não finalizados), limitados a um
      // intervalo curto pra evitar que pedidos esquecidos há dias fiquem
      // presos na tela.
      // CORREÇÃO: antes o filtro exigia created_at::date = hoje::date. Isso
      // escondia da cozinha qualquer pedido de mesa aberto antes da meia-noite
      // (ex.: mesa aberta às 23h) assim que o relógio virava o dia — o pedido
      // continuava ativo (status Criado/Em Preparo) mas sumia da tela, e
      // qualquer item lançado nele depois da virada nunca aparecia. Trocado
      // por uma janela de 1 dia pra trás, mantendo o mesmo objetivo (não
      // acumular pedido antigo) sem descartar mesas ainda abertas.
      const allOrders = await qAll(
        `SELECT * FROM pedidos
         WHERE tenant_id=?
           AND ${buildOperationalKdsOrderClause()}
           AND (created_at AT TIME ZONE '${TZ}')::date >= (NOW() AT TIME ZONE '${TZ}')::date - 1
         ORDER BY created_at ASC`,
        [tenant.id]
      );

      if (allOrders.length === 0) {
        return res.json({ estabelecimento: tenant.nome_estabelecimento, orders: [] });
      }

      // 2ª query: todos os itens de uma vez (evita N+1)
      const orderIds = allOrders.map((o: any) => o.id);
      const placeholders = orderIds.map(() => '?').join(',');
      const allItems = await qAll(
        `SELECT i.order_id, i.quantity, i.type, i.price_at_time,
                p.name as product_name, p.category as product_category,
                p.requires_preparation, p.production_type
         FROM itens_pedido i
         LEFT JOIN produtos p ON p.id=i.product_id AND p.tenant_id=i.tenant_id
         WHERE i.order_id IN (${placeholders}) AND i.tenant_id=?`,
        [...orderIds, tenant.id]
      );

      // Agrupa itens por pedido em memória
      const itemsByOrder = new Map<number, any[]>();
      for (const item of allItems) {
        const list = itemsByOrder.get(item.order_id) || [];
        list.push(item);
        itemsByOrder.set(item.order_id, list);
      }

      // Deduplica pedidos de mesa (mantém o mais recente por mesa pra exibição).
      // CORREÇÃO: quando duas requisições de "adicionar item" pra mesma mesa
      // chegam quase juntas, `syncKdsItem` (routes/mesas.ts) pode não achar o
      // pedido KDS ainda sendo criado pela outra e acabar criando um segundo
      // pedido pra mesma mesa (race condition). Antes, aqui a gente descartava
      // esse pedido "duplicado" inteiro — e os itens lançados nele sumiam da
      // cozinha pra sempre, mesmo continuando certinhos na comanda da mesa.
      // Agora mantém o pedido mais recente pra exibição, mas MESCLA os itens
      // de todos os pedidos duplicados daquela mesa nele, então nenhum item
      // fica escondido.
      const seen = new Map<string, any>();
      for (const o of allOrders) {
        const key = (o.observation || '').startsWith('Mesa ') ? o.observation : String(o.id);
        const ex = seen.get(key);
        if (!ex || o.id > ex.id) seen.set(key, o);
      }

      for (const o of allOrders) {
        const key = (o.observation || '').startsWith('Mesa ') ? o.observation : String(o.id);
        const primary = seen.get(key);
        if (!primary || primary.id === o.id) continue;
        const primaryItems = itemsByOrder.get(primary.id) || [];
        const extraItems = itemsByOrder.get(o.id) || [];
        if (extraItems.length > 0) itemsByOrder.set(primary.id, [...primaryItems, ...extraItems]);
      }

      const deduped = Array.from(seen.values())
        .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      const orders = [];
      for (const o of deduped) {
        const items = itemsByOrder.get(o.id) || [];
        const prepItems = items
          .filter((item: any) =>
            resolveRequiresPreparation({
              name: item.product_name,
              category: item.product_category,
              requires_preparation: item.requires_preparation,
              production_type: item.production_type,
            })
          )
          .map((item: any) => ({
            quantity: item.quantity,
            type: item.type,
            price_at_time: item.price_at_time,
            product_name: item.product_name,
          }));
        if (prepItems.length > 0) orders.push({ ...o, items: prepItems });
      }

      res.json({ estabelecimento: tenant.nome_estabelecimento, orders });
    } catch (error) {
      handlePublicRouteError(res, 'GET /public/kds/:slug', slug, error);
    }
  });

  // ── KDS SSE (keep-alive) ──────────────────────────────────────────────────
  router.get('/public/kds/:slug/events', requireKioskToken('kds'), async (req, res) => {
    const slug = getPublicSlugOrReject(res, req.params.slug);
    if (!slug) return;

    try {
      const tenant = await q1('SELECT id FROM clientes WHERE usuario=?', [slug]);
      if (!tenant) return res.status(404).end();

      const tenantId = Number(tenant.id);
      if (!Number.isFinite(tenantId) || tenantId <= 0) return res.status(404).end();

      setupSseStream(tenantId, req, res);
    } catch (error) {
      handlePublicRouteError(res, 'GET /public/kds/:slug/events', slug, error);
    }
  });

  router.patch('/public/kds/:slug/orders/:id/advance', kdsAdvanceLimit, requireBrowserOrigin, requireKioskToken('kds'), async (req, res) => {
    const slug = getPublicSlugOrReject(res, req.params.slug);
    if (!slug) return;

    try {
      const tenant = await q1('SELECT id FROM clientes WHERE usuario=? AND status=?', [slug, 'ativo']);
      if (!tenant) return res.status(404).json({ error:'Não encontrado' });
      const order = await q1('SELECT status, cancelado_at FROM pedidos WHERE id=? AND tenant_id=?', [req.params.id, tenant.id]);
      if (!order) return res.status(404).json({ error:'Pedido não encontrado' });
      if (isCanceledOrder(order)) return res.status(400).json({ error:'Pedido cancelado nao pode voltar ao KDS' });
      const idx = PIPELINE_KDS.indexOf(order.status);
      const next = idx >= 0 && idx < PIPELINE_KDS.length - 1 ? PIPELINE_KDS[idx+1] : null;
      if (!next) return res.json({ success:true, message:'Já no status final' });
      await qRun('UPDATE pedidos SET status=? WHERE id=? AND tenant_id=?', [next, req.params.id, tenant.id]);
      await emitWhatsAppOrderStatusEvent({
        tenantId: tenant.id,
        orderId: req.params.id,
        status: next,
        source: 'routes.kiosk.advanceKdsOrder',
      });
      notifyTenantOrderStreams(Number(tenant.id), 'status', { orderId: Number(req.params.id), newStatus: next });
      res.json({ success:true, newStatus:next });
    } catch (error) {
      handlePublicRouteError(res, 'PATCH /public/kds/:slug/orders/:id/advance', slug, error);
    }
  });

  // ── Cardápio público ──────────────────────────────────────────────────────
  router.get('/public/cardapio/:slug', async (req, res) => {
    const slug = getPublicSlugOrReject(res, req.params.slug);
    if (!slug) return;

    try {
      const tenant = await q1('SELECT id,nome_estabelecimento FROM clientes WHERE usuario=?', [slug]);
      if (!tenant) return res.status(404).json({ error:'Restaurante não encontrado' });
      const prods = await qAll('SELECT id,name,price,category,photo_url,color FROM produtos WHERE tenant_id=? AND active=1 ORDER BY category ASC, name ASC', [tenant.id]);
      const byCat: Record<string,any[]> = {};
      for (const p of prods) {
        const c = p.category || 'Geral';
        if (!byCat[c]) byCat[c] = [];
        byCat[c].push({ ...p, photo_url: normalizeProductPhotoPublicUrl(p.photo_url) });
      }
      res.json({ estabelecimento:tenant.nome_estabelecimento, categorias:Object.entries(byCat).map(([nome,itens])=>({nome,itens})) });
    } catch (error) {
      handlePublicRouteError(res, 'GET /public/cardapio/:slug', slug, error);
    }
  });

  // ── Mesa QR code ──────────────────────────────────────────────────────────
  router.post('/public/mesa/:slug/:numero/pedir', requireBrowserOrigin, async (req, res) => {
    const slug = getPublicSlugOrReject(res, req.params.slug);
    if (!slug) return;

    try {
      const { numero } = req.params;
      const { itens } = req.body;
      if (!itens||!itens.length) return res.status(400).json({ error:'Carrinho vazio' });
      const tenant = await q1('SELECT id FROM clientes WHERE usuario=?', [slug]);
      if (!tenant) return res.status(404).json({ error:'Restaurante não encontrado' });
      const mesa = await q1('SELECT * FROM mesas WHERE numero=? AND tenant_id=?', [numero, tenant.id]);
      if (!mesa) return res.status(404).json({ error:'Mesa não encontrada' });
      let comanda = await q1("SELECT * FROM comandas WHERE mesa_id=? AND status='aberta' AND tenant_id=? LIMIT 1", [mesa.id, tenant.id]);
      if (!comanda) {
        await qRun("UPDATE mesas SET status='aberta', opened_at=NOW() WHERE id=? AND tenant_id=?", [mesa.id, tenant.id]);
        const cid = await qInsert("INSERT INTO comandas (mesa_id,tenant_id,status) VALUES (?,?,'aberta')", [mesa.id, tenant.id]);
        comanda = await q1('SELECT * FROM comandas WHERE id=?', [cid]);
      }
      for (const item of itens) {
        const qtd = Number(item.quantity)||1;
        const ex = await q1('SELECT * FROM itens_comanda WHERE comanda_id=? AND product_id=? AND tenant_id=?', [comanda.id, item.product_id, tenant.id]);
        if (ex) await qRun('UPDATE itens_comanda SET quantity=quantity+? WHERE id=? AND tenant_id=?', [qtd, ex.id, tenant.id]);
        else await qInsert('INSERT INTO itens_comanda (comanda_id,product_id,product_name,quantity,price_at_time,tenant_id) VALUES (?,?,?,?,?,?)', [comanda.id, item.product_id, item.name, qtd, item.price_at_time, tenant.id]);
      }
      await syncMesaOrderVisibility(
        Number(tenant.id),
        { id: Number(mesa.id), numero: Number(mesa.numero) },
        Number(comanda.id),
        itens.map((item: any) => ({
          product_id: Number(item.product_id),
          quantity: Number(item.quantity) || 1,
          price_at_time: Number(item.price_at_time) || 0,
        }))
      );
      res.json({ success:true });
    } catch (error) {
      handlePublicRouteError(res, 'POST /public/mesa/:slug/:numero/pedir', slug, error);
    }
  });

  return router;
}