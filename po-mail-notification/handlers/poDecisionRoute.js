'use strict';

const Constants = require('../constants/PoConstants');
const PoDecisionToken = require('../utils/PoDecisionToken');
const { escapeHtml } = require('./../services/PoMailTemplate');
const { formatRunStamp } = require('../utils/PoDateUtil');
const OutlookActionAuth = require('../utils/OutlookActionAuth');
const PoApprovalCard = require('../utils/PoApprovalCard');

const shell = ({ accent, title, bodyHtml }) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#eef1f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 12px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.12);">
<tr><td style="background:${accent};padding:20px 28px;color:#ffffff;font-size:18px;font-weight:bold;">${escapeHtml(title)}</td></tr>
<tr><td style="padding:26px 28px;font-size:14px;color:#202124;line-height:22px;">${bodyHtml}</td></tr>
<tr><td style="background:#5f6368;padding:14px 28px;color:#ffffff;font-size:12px;text-align:center;">MOBI Integration Platform &nbsp;•&nbsp; Automated decision page</td></tr>
</table></td></tr></table></body></html>`;

const row = (label, value) => `<tr><td style="padding:4px 12px 4px 0;color:#5f6368;white-space:nowrap;">${label}</td><td style="padding:4px 0;"><b>${escapeHtml(value || '-')}</b></td></tr>`;

function decisionPage(payload, token = '', notice = '') {
  const approve = payload.a === 'approve';
  return shell({
    accent: approve ? '#2e7d32' : '#c2183a',
    title: approve ? 'Approve purchase order' : 'Reject purchase order',
    bodyHtml: `
${notice ? `<p style="background:#fdecea;border:1px solid #e53950;border-radius:6px;padding:10px 12px;color:#c2183a;font-weight:bold;">${escapeHtml(notice)}</p>` : ''}
<p>You are about to <b style="color:${approve ? '#2e7d32' : '#c2183a'};">${approve ? 'APPROVE' : 'REJECT'}</b> the following purchase order:</p>
<table cellpadding="0" cellspacing="0" style="margin:14px 0;">
${row('PO Number', payload.p)}
${row('Company Code', payload.c)}
${row('Document Type', payload.d)}
${row('Approval Level', String(payload.l))}
${row('Link expires', formatRunStamp(new Date(payload.e * 1000), Constants.TIME_ZONE))}
</table>
<label for="remarks" style="display:block;margin:6px 0 4px 0;color:#5f6368;font-size:13px;">Remarks ${approve ? '(optional - recorded with your approval)' : '<b style="color:#c2183a;">(required - reason for rejection)</b>'}</label>
<textarea id="remarks" name="remarks" form="f" rows="3" maxlength="1000" ${approve ? '' : 'required'} style="width:100%;box-sizing:border-box;border:1px solid #c4c7cc;border-radius:6px;padding:8px 10px;font-family:inherit;font-size:14px;color:#202124;" placeholder="${approve ? 'Optional comment.' : 'Why is this PO being rejected?'}"></textarea>
<form method="POST" action="${Constants.DECISION_ROUTE}/confirm" id="f">
<input type="hidden" name="t" value="${escapeHtml(token)}">
</form>
<p style="margin-top:18px;">
<button type="submit" form="f" style="background:${approve ? '#43a047' : '#e53950'};border:0;border-radius:6px;color:#fff;font-size:15px;font-weight:bold;padding:12px 26px;cursor:pointer;">${approve ? '✅ Confirm APPROVE' : '❌ Confirm REJECT'}</button>
&nbsp;&nbsp;<a href="about:blank" onclick="window.close();return false;" style="color:#5f6368;">Cancel</a>
</p>
<p style="color:#5f6368;font-size:12px;margin-top:16px;">This link is single use and expires in ${Constants.DECISION_TOKEN_HOURS} hours. Your decision is recorded with your user id.</p>`
  });
}

function renderDecisionPage(payload, token, notice = '') {
  return decisionPage(payload, token, notice);
}

function errorPage(reason) {
  return shell({
    accent: '#b06000',
    title: 'Decision link not accepted',
    bodyHtml: `<p style="color:#b06000;font-weight:bold;">${escapeHtml(reason)}</p>
<p>Approval links expire after ${Constants.DECISION_TOKEN_HOURS} hours, can be used once, and stop working after a server restart when no fixed <code>PO_MAIL_TOKEN_SECRET</code> is configured.</p>
<p>If you still need to decide this purchase order, ask the PO mail team to re-send the approval mail (<code>force: true</code>).</p>`
  });
}

function resultPage(result) {
  const good = ['APPROVED_FORWARDED', 'FULLY_APPROVED', 'DRY_RUN'].includes(result.status);
  const neutral = result.status === 'ALREADY_DECIDED';
  return shell({
    accent: good ? '#2e7d32' : neutral ? '#5f6368' : '#c2183a',
    title: `Decision recorded: ${result.status}`,
    bodyHtml: `
<table cellpadding="0" cellspacing="0" style="margin:6px 0 14px 0;">
${row('PO Number', result.poNumber)}
${row('Company Code', result.companyCode)}
${row('Level', String(result.level))}
${row('Action', result.action)}
${row('Decided by', result.decidedBy)}
${result.nextLevel ? row('Forwarded to Level', String(result.nextLevel)) : ''}
${result.mailedTo ? row('Mailed to', result.mailedTo) : ''}
${result.remarks ? row('Remarks', result.remarks) : ''}
</table>
<p>${escapeHtml(result.message || '')}</p>
<p style="color:#5f6368;font-size:12px;">You can close this window now.</p>`
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function extractToken(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.t) return String(parsed.t);
  } catch (error) { /* fall through to form encoding */ }
  const match = raw.match(/(?:^|&)t=([^&]+)/);
  return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
}

function extractRemarks(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.remarks !== undefined) return String(parsed.remarks);
  } catch (error) { /* fall through to form encoding */ }
  const match = raw.match(/(?:^|&)remarks=([^&]*)/);
  return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
}

async function readActionBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : await readBody(req);
  try { return JSON.parse(raw || '{}'); } catch (error) { return {}; }
}

function register(app, deps) {
  app.get(Constants.DECISION_ROUTE, async (req, res) => {
    const token = String(req.query?.t || '');
    const checked = PoDecisionToken.verify(token);
    if (!checked.ok) return res.status(400).send(errorPage(checked.reason));
    try {
      const existing = await deps.service.approvals.getDecision(checked.payload.p, checked.payload.c, checked.payload.l);
      if (existing) {
        return res.status(200).send(resultPage({
          status: 'ALREADY_DECIDED', poNumber: checked.payload.p, companyCode: checked.payload.c,
          level: checked.payload.l, action: existing.decision === 'APPROVED' ? 'approve' : 'reject',
          decidedBy: existing.decidedBy, nextLevel: existing.nextLevel || 0, mailedTo: existing.nextMailedTo || '',
          remarks: existing.remarks || '',
          message: `This level was already decided by ${existing.decidedBy}. Decision links are single use.`
        }));
      }
      return res.status(200).send(renderDecisionPage(checked.payload, token));
    } catch (error) {
      return res.status(500).send(errorPage(error.message));
    }
  });

  app.post(`${Constants.DECISION_ROUTE}/confirm`, async (req, res) => {
    try {
      const raw = await readBody(req);
      const token = extractToken(raw);
      const checked = PoDecisionToken.verify(token);
      if (!checked.ok) return res.status(400).send(errorPage(checked.reason));

      const remarks = extractRemarks(raw).trim();
      if (checked.payload.a === 'reject' && !remarks) {
        return res.status(200).send(renderDecisionPage(checked.payload, token, 'Remarks are required to reject this purchase order.'));
      }

      const user = req.user?.id || req.user?.email || req.user?.attr?.email || '';
      const decidedBy = user || `Level ${checked.payload.l} approver via signed mail link`;
      const result = await deps.service.applyDecision({ payload: checked.payload, decidedBy, actor: decidedBy, remarks });
      return res.status(200).send(resultPage(result));
    } catch (error) {
      return res.status(500).send(errorPage(error.message));
    }
  });

  app.post(Constants.ACTION_ROUTE, async (req, res) => {
    try {
      const body = await readActionBody(req);
      const token = String(body.token || body.t || '');
      const checked = PoDecisionToken.verify(token);
      if (!checked.ok) {
        res.set('CARD-ACTION-STATUS', checked.reason);
        return res.status(400).json({ error: checked.reason });
      }
      const payload = checked.payload;
      if (payload.a !== 'approve') {
        res.set('CARD-ACTION-STATUS', 'Only approval actions are supported in this Outlook card.');
        return res.status(403).json({ error: 'Action is not permitted.' });
      }

      const authentication = await OutlookActionAuth.verifyRequest(req, payload.r || []);
      if (!authentication.ok) {
        res.set('CARD-ACTION-STATUS', authentication.reason);
        return res.status(401).json({ error: authentication.reason });
      }

      const phase = String(body.intent || '');
      const cardArgs = {
        token,
        po: { poNumber: payload.p, companyCode: payload.c, documentType: payload.d },
        level: payload.l,
        expectedActors: payload.r || [],
        approvalFlow: (payload.f || []).map((entry) => ({ level: entry.l, recipients: entry.r || [] }))
      };
      if (phase === 'confirm') {
        const card = PoApprovalCard.build({ ...cardArgs, phase: 'confirm' });
        res.set('CARD-UPDATE-IN-BODY', 'true');
        res.set('Cache-Control', 'no-store');
        return res.status(200).json(card);
      }
      if (phase === 'cancel') {
        const card = PoApprovalCard.build({ ...cardArgs, phase: 'pending' });
        res.set('CARD-UPDATE-IN-BODY', 'true');
        res.set('Cache-Control', 'no-store');
        return res.status(200).json(card);
      }
      if (phase !== 'approve') {
        res.set('CARD-ACTION-STATUS', 'Unknown approval action.');
        return res.status(400).json({ error: 'Unknown approval action.' });
      }

      const ledger = await deps.service.approvals.info();
      if (ledger.mode !== 'PERSISTED') {
        res.set('CARD-ACTION-STATUS', 'Approval storage is not persistent. Ask the PO support team to deploy the approval entity.');
        return res.status(503).json({ error: 'Persistent CAP approval storage is required for Outlook approvals.' });
      }

      const result = await deps.service.applyDecision({
        payload,
        decidedBy: authentication.actor,
        actor: authentication.actor
      });
      const card = PoApprovalCard.build({ ...cardArgs, phase: 'complete', result });
      res.set('CARD-UPDATE-IN-BODY', 'true');
      res.set('CARD-ACTION-STATUS', result.message || result.status);
      res.set('Cache-Control', 'no-store');
      return res.status(200).json(card);
    } catch (error) {
      res.set('CARD-ACTION-STATUS', 'Approval could not be processed. Please contact the PO support team.');
      return res.status(500).json({ error: 'Approval action could not be processed.' });
    }
  });

  console.log(`[PoDecisionRoute] Browser confirmation routes mounted at ${Constants.DECISION_ROUTE}; Outlook Action.Http route mounted at ${Constants.ACTION_ROUTE}.`);
}

module.exports = { register };