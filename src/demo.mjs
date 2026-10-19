import { mkdir, writeFile } from 'node:fs/promises';
import { createDatabase } from './db.mjs';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[ch]);

const db = await createDatabase({ seed: true });
const sources = (await db.query('SELECT * FROM reconcile.source_health ORDER BY source')).rows;
const orders = (await db.query('SELECT * FROM reconcile.order_snapshot ORDER BY source, external_id')).rows;
const events = (await db.query(`
  SELECT s.code AS source, e.external_event_id, e.event_type, t.accepted, t.reason
  FROM reconcile.inbox_events e
  JOIN reconcile.sources s ON s.id = e.source_id
  LEFT JOIN reconcile.transitions t ON t.inbox_event_id = e.id
  ORDER BY e.id DESC
`)).rows;

const total = (field) => sources.reduce((sum, row) => sum + Number(row[field]), 0);
const cell = (text) => `<td>${escapeHtml(text)}</td>`;
const status = (value) => `<span class="pill ${escapeHtml(value)}">${escapeHtml(value)}</span>`;
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Reconcile DB Lab · Visão operacional</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090f1d;color:#ecf5ff}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 90% 0,#123647 0,transparent 34%),#090f1d}
    main{max-width:1200px;margin:auto;padding:48px 24px 80px}.eyebrow{color:#52ead1;font-size:12px;letter-spacing:.17em;font-weight:800}
    h1{font-size:clamp(36px,5vw,60px);line-height:1.05;margin:20px 0 12px;letter-spacing:-.05em}p{color:#a4b6ce;max-width:650px;line-height:1.6}
    .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:34px 0}.stat,.panel{background:#111c2e;border:1px solid #26405a;border-radius:16px}
    .stat{padding:22px}.stat span{display:block;color:#8ca6c1;font-size:12px;text-transform:uppercase;letter-spacing:.12em}.stat strong{font-size:36px;display:block;margin-top:10px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.panel{padding:24px;overflow:auto;margin-bottom:18px}.wide{grid-column:1/-1}
    h2{margin:0 0 18px;font-size:19px}table{border-collapse:collapse;width:100%;min-width:530px}th{text-align:left;color:#7e9bb8;text-transform:uppercase;font-size:11px;letter-spacing:.08em}
    td,th{padding:13px 9px;border-bottom:1px solid #24374f;white-space:nowrap}td{font-size:13px}tr:last-child td{border-bottom:0}
    .pill{display:inline-block;padding:5px 10px;border-radius:999px;background:#193d50;color:#80e8ff;font-size:11px;font-weight:700}
    .approved,.fulfilled,.true{background:#174c40;color:#71ecc6}.cancelled,.false{background:#4d2734;color:#ff9cae}.pending{background:#394158;color:#b5caff}
    footer{font-size:12px;color:#728ba7;margin-top:18px}@media(max-width:760px){.stats{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}
  </style>
</head>
<body><main>
  <div class="eyebrow">POSTGRESQL / DATA INTEGRITY / AUDIT</div>
  <h1>O dado precisa fechar.</h1>
  <p>Uma demonstração local de reconciliação de eventos entre sistemas. Cada evento tem identidade, tratamento de repetição, validação de transição e trilha imutável.</p>
  <section class="stats">
    <div class="stat"><span>Pedidos</span><strong>${total('orders')}</strong></div>
    <div class="stat"><span>Eventos recebidos</span><strong>${total('received_events')}</strong></div>
    <div class="stat"><span>Aplicados</span><strong>${total('applied_events')}</strong></div>
    <div class="stat"><span>Rejeitados</span><strong>${total('rejected_events')}</strong></div>
  </section>
  <div class="grid">
    <section class="panel wide"><h2>Pedidos reconciliados</h2><table><thead><tr><th>Origem</th><th>ID externo</th><th>Cliente</th><th>Valor</th><th>Status</th><th>Versão</th><th>Rejeições</th></tr></thead><tbody>
      ${orders.map((o) => `<tr>${cell(o.source)}${cell(o.external_id)}${cell(o.customer_name)}${cell(currency.format(Number(o.amount_cents) / 100))}<td>${status(o.status)}</td>${cell(o.version)}${cell(o.rejected_transitions)}</tr>`).join('')}
    </tbody></table></section>
    <section class="panel"><h2>Saúde por origem</h2><table><thead><tr><th>Sistema</th><th>Pedidos</th><th>Eventos</th><th>Rejeições</th></tr></thead><tbody>
      ${sources.map((s) => `<tr>${cell(s.source)}${cell(s.orders)}${cell(s.received_events)}${cell(s.rejected_events)}</tr>`).join('')}
    </tbody></table></section>
    <section class="panel"><h2>Trilha de entrada</h2><table><thead><tr><th>Origem</th><th>Evento</th><th>Tipo</th><th>Resultado</th></tr></thead><tbody>
      ${events.map((e) => `<tr>${cell(e.source)}${cell(e.external_event_id)}${cell(e.event_type)}<td>${status(e.accepted ? 'applied' : 'rejected')}</td></tr>`).join('')}
    </tbody></table></section>
  </div>
  <footer>Dados sintéticos. Relatório estático gerado localmente; nenhuma credencial ou banco externo é necessário.</footer>
</main></body></html>`;

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/index.html', import.meta.url), html, 'utf8');
await db.close();
console.log('Relatório gerado em dist/index.html');
