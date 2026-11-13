'use strict';

/**
 * Pure HTML builder for the PO creation / approval mail (no dependencies, no I/O).
 *
 * Follows the approved house structure from shared/mail/templates.js
 * (colour-coded banner, boxed sections, MOBI Integration Platform footer) and
 * renders EVERY field required for the PO mail:
 *
 *   Logo                              Sl. No / Item                 Tax %
 *   Company Address                   Description                   Base Price
 *   Supplier Code / Supplier          Delivery Date                 Tax
 *   Supplier Name                     Quantity                      Total Amount
 *   Supplier Address                  Unit Price                    Total Base Price
 *   Supplier Tax Number                                             Tax
 *   PO Number                                                       Total Amount / Net PO Value
 *   Date (Created On)                                               Total Amount in Words
 *   Payment Terms (As per Remark)                                   Remarks (Header Text)
 *   Currency                                                        Document Type
 *                                                                  Created By
 *                                                                  Company Code
 *                                                                  Purchasing Organization
 *                                                                  Purchasing Group
 *                                                                  Payment Terms
 *
 * Images are referenced by CID (`cid:mobiLogo`) so the logo is embedded in the
 * MIME message — it renders in Outlook / mobile clients that block remote images.
 */

const Constants = require('../constants/PoConstants');

/* ── primitives ─────────────────────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** Escape + keep line breaks from SAP header text readable. */
function escapeMultiline(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/** Value or a neutral placeholder so the layout never collapses. */
function orDash(value) {
  const text = String(value ?? '').trim();
  return text
    ? escapeHtml(text)
    : '<span style="color:#9aa0a6;">&mdash;</span>';
}

function rawOrDash(value) {
  const text = String(value ?? '').trim();
  return text ? escapeHtml(text) : '<span style="color:#9aa0a6;">&mdash;</span>';
}

function kvRow(label, valueHtml, { strong = false } = {}) {
  const value = strong
    ? `<b style="font-size:14px;">${valueHtml}</b>`
    : valueHtml;
  return `<tr>
<td width="42%" style="padding:6px 8px;border-bottom:1px solid #e6e8eb;color:#5f6368;font-size:13px;">${escapeHtml(label)}</td>
<td style="padding:6px 8px;border-bottom:1px solid #e6e8eb;color:#202124;font-size:13px;">${value}</td>
</tr>`;
}

function section({ title, accent, rowsHtml, note = '' }) {
  return `<tr>
<td style="padding:18px 40px 0 40px;">
<div style="border:1px solid #e6e8eb;border-left:6px solid ${accent};border-radius:4px;background:#ffffff;">
<div style="background:#fafbfc;padding:10px 16px;border-bottom:1px solid #e6e8eb;">
<span style="font-size:14px;font-weight:bold;color:${accent};text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(title)}</span>
</div>
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
${rowsHtml}
</table>
${note ? `<div style="padding:10px 16px;font-size:12px;color:#5f6368;">${note}</div>` : ''}
</div>
</td>
</tr>`;
}

/* ── banner / logo ──────────────────────────────────────────────────────── */

function logoHtml(logoAvailable) {
  if (logoAvailable) {
    return `<img src="cid:${Constants.LOGO_CID}" width="${Constants.LOGO_WIDTH_PX}" alt="MOBI" ` +
      `style="display:block;max-width:${Constants.LOGO_WIDTH_PX}px;height:auto;border:0;background:#ffffff;` +
      `padding:10px 14px;border-radius:6px;" />`;
  }
  // Placeholder until mobi-logo.png is dropped into resources/ (see README).
  return `<div style="display:inline-block;background:#ffffff;color:#0b2d5b;font-size:26px;font-weight:bold;` +
    `letter-spacing:2px;padding:10px 20px;border-radius:6px;">MOBI</div>`;
}

function banner({ logoAvailable, environment, title = 'Purchase Order Approval Request' }) {
  return `<tr>
<td align="center" style="background:#0b2d5b;padding:24px 20px;border-radius:8px 8px 0 0;">
${logoHtml(logoAvailable)}
<div style="color:#ffffff;font-size:22px;font-weight:bold;margin-top:14px;">${escapeHtml(title)}</div>
<div style="color:#c9d6ea;font-size:17px;font-weight:bold;margin-top:8px;">${escapeHtml(environment)}</div>
</td>
</tr>`;
}

/* ── line item table ────────────────────────────────────────────────────── */

const ITEM_COLUMNS = Object.freeze([
  { key: 'slNo', label: 'Sl. No', width: '5%', align: 'center' },
  { key: 'item', label: 'Item', width: '7%', align: 'center' },
  { key: 'description', label: 'Description', width: '24%', align: 'left' },
  { key: 'deliveryDate', label: 'Delivery Date', width: '10%', align: 'center' },
  { key: 'quantity', label: 'Quantity', width: '9%', align: 'right' },
  { key: 'unitPrice', label: 'Unit Price', width: '10%', align: 'right' },
  { key: 'taxPercent', label: 'Tax %', width: '6%', align: 'center' },
  { key: 'basePrice', label: 'Base Price', width: '10%', align: 'right' },
  { key: 'tax', label: 'Tax', width: '9%', align: 'right' },
  { key: 'total', label: 'Total Amount', width: '10%', align: 'right' }
]);

function itemHeaderRow() {
  return `<tr>${ITEM_COLUMNS.map((column) => (
    `<th align="${column.align}" width="${column.width}" style="background:#0b2d5b;color:#ffffff;font-size:11px;` +
    `font-weight:bold;padding:8px 6px;border:1px solid #0b2d5b;text-transform:uppercase;">${escapeHtml(column.label)}</th>`
  )).join('')}</tr>`;
}

function itemRow(item, index) {
  const shade = index % 2 === 1 ? 'background:#f7f9fc;' : '';
  return `<tr style="${shade}">${ITEM_COLUMNS.map((column) => {
    const value = item[column.key];
    const text = String(value ?? '').trim();
    const cell = text ? escapeHtml(value) : '<span style="color:#9aa0a6;">&mdash;</span>';
    const bold = column.key === 'description' ? 'font-weight:bold;' : '';
    return `<td align="${column.align}" style="padding:8px 6px;border:1px solid #e6e8eb;font-size:12px;` +
      `color:#202124;${bold}">${cell}</td>`;
  }).join('')}</tr>`;
}

function itemsSection(po) {
  const rows = (po.items || []).map(itemRow).join('');
  return `<tr>
<td style="padding:18px 40px 0 40px;">
<div style="border:1px solid #e6e8eb;border-radius:4px;">
<div style="background:#fafbfc;padding:10px 16px;border-bottom:1px solid #e6e8eb;">
<span style="font-size:14px;font-weight:bold;color:#0b2d5b;text-transform:uppercase;letter-spacing:0.5px;">Line Items</span>
<span style="float:right;font-size:12px;color:#5f6368;">${(po.items || []).length} item(s)</span>
</div>
<div style="padding:12px;overflow-x:auto;">
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:900px;">
${itemHeaderRow()}
${rows || `<tr><td colspan="10" align="center" style="padding:14px;color:#5f6368;font-size:13px;">No line items returned by the PO CDS view.</td></tr>`}
</table>
</div>
</div>
</td>
</tr>`;
}

/* ── net value + amount in words ────────────────────────────────────────── */

function netValueSection(po) {
  return `<tr>
<td style="padding:18px 40px 0 40px;">
<div style="background:#eef7ff;border-left:6px solid #009de0;border-radius:4px;padding:16px 20px;">
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
${kvRow('Total Base Price', orDash(po.totals.totalBasePrice))}
${kvRow('Tax', orDash(po.totals.totalTax))}
${kvRow('Total Amount / Net PO Value',
  `<span style="font-size:18px;font-weight:bold;color:#0b2d5b;">${orDash(po.totals.totalAmount)}</span>`, { strong: false })}
${kvRow('Total Amount in Words', `<i>${orDash(po.totals.totalAmountInWords)}</i>`)}
</table>
</div>
</td>
</tr>`;
}

/* ── approval flow ──────────────────────────────────────────────────────── */

/**
 * Render the static approval-level summary. Approval itself is completed in
 * SAP S/4HANA My Inbox; this summary is informational and has no actions.
 */
function approvalSection({ routing, triggerLevel, completed = false, rejected = false, rejectedLevel = 0 }) {
  const fullChain = routing?.chain || [];
  const chain = rejected ? fullChain.filter((entry) => entry.level <= rejectedLevel) : fullChain;
  const rows = chain.map((entry) => {
    const isRejectedLevel = rejected && entry.level === rejectedLevel;
    const isTrigger = !completed && !rejected && entry.level === triggerLevel;
    const isDone = completed || (!rejected && entry.level < triggerLevel) || (rejected && entry.level < rejectedLevel);
    const chip = isRejectedLevel
      ? `<span style="display:inline-block;background:#fde8e7;color:#b3261e;font-size:10px;font-weight:bold;` +
        `padding:2px 8px;border-radius:10px;margin-left:8px;">REJECTED</span>`
      : isDone
        ? `<span style="display:inline-block;background:#e8f5e9;color:#2e7d32;font-size:10px;font-weight:bold;` +
          `padding:2px 8px;border-radius:10px;margin-left:8px;">APPROVED</span>`
        : isTrigger
          ? `<span style="display:inline-block;background:#0b2d5b;color:#ffffff;font-size:10px;font-weight:bold;` +
            `padding:2px 8px;border-radius:10px;margin-left:8px;">ACTION REQUIRED</span>`
          : `<span style="display:inline-block;background:#e6e8eb;color:#5f6368;font-size:10px;font-weight:bold;` +
            `padding:2px 8px;border-radius:10px;margin-left:8px;">PENDING</span>`;
    return `<tr>
<td width="18%" style="padding:6px 8px;border-bottom:1px solid #e6e8eb;font-size:13px;color:#202124;">
<b>Level ${escapeHtml(entry.level)}</b>${chip}</td>
<td style="padding:6px 8px;border-bottom:1px solid #e6e8eb;font-size:13px;color:#202124;">
${entry.recipients.map(escapeHtml).join('<br>')}</td>
</tr>`;
  }).join('');

  return section({
    title: 'Approval Flow — Notification Recipients by Level',
    accent: '#7b1fa2',
    rowsHtml: rows || kvRow('Notification Recipients', orDash('')),
    note: 'These are email notification groups. Actual approvers and task progression are configured in S/4HANA Flexible Workflow.'
  });
}

/* ── S/4HANA launchpad link ─────────────────────────────────────────────── */

/**
 * Clickable button that opens the SAP S/4HANA launchpad (My Inbox lives
 * there). The URL comes from configuration (Constants.S4_LAUNCHPAD_URL →
 * PO_S4_LAUNCHPAD_URL env) and is never hardcoded in the template.
 * Returns '' when no URL is configured, so the row is omitted entirely.
 */
function launchpadButton() {
  const url = String(Constants.S4_LAUNCHPAD_URL || '').trim();
  if (!url) return '';
  return `<tr>
<td align="center" style="padding:20px 40px 0 40px;">
<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="display:inline-block;background:#0b2d5b;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;padding:12px 30px;border-radius:6px;border:1px solid #0b2d5b;">Open SAP S/4HANA My Inbox</a>
</td>
</tr>`;
}

/* ── shell ──────────────────────────────────────────────────────────────── */

function shell({
  logoAvailable,
  environment,
  po,
  headline = `Purchase Order ${po?.poNumber || ''} has been created`,
  bannerTitle = 'Purchase Order Approval Request',
  greetingHtml,
  bodyHtml,
  actionableCardJson = ''
}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Purchase Order ${escapeHtml(po.poNumber)}</title>
${actionableCardJson ? `<script type="application/adaptivecard+json">${actionableCardJson}</script>` : ''}
</head>
<body style="margin:0;padding:20px;background:#f2f4f7;font-family:Arial,Helvetica,sans-serif;">
<table align="center" width="1000" cellpadding="0" cellspacing="0" style="max-width:1000px;background:#ffffff;border:1px solid #d9d9d9;border-radius:8px;">
${banner({ logoAvailable, environment, title: bannerTitle })}
<tr>
<td style="padding:26px 40px 6px 40px;">
<div style="font-size:18px;font-weight:bold;color:#202124;">${escapeHtml(headline)}</div>
<p style="font-size:14px;color:#444444;line-height:22px;margin:12px 0 0 0;">Hello Team,<br><br>${greetingHtml}</p>
</td>
</tr>
${bodyHtml}
<tr>
<td align="center" style="background:#555555;color:#ffffff;padding:20px;border-radius:0 0 8px 8px;font-size:15px;line-height:23px;">
<b style="font-size:16px;">MOBI Integration Platform</b><br>
This is an automatically generated email from SAP Cloud Integration.<br>
Please do not reply.
</td>
</tr>
</table>
</body>
</html>`;
}

/* ── public API ─────────────────────────────────────────────────────────── */

/**
 * Build the PO creation mail.
 * @param {object} args
 * @param {object} args.po        normalised PO (see PoMailService._normalize)
 * @param {Array}  args.to        level-1 approver addresses
 * @param {object} args.routing   { ruleId, action, chain }
 * @param {number} args.triggerLevel
 * @param {string} args.environment
 * @param {boolean} args.logoAvailable
 * @param {string} args.runStamp
 * @param {boolean} [args.degraded]  date filter was not usable for this run
 * @returns {{subject:string, html:string}}
 */
function buildPoApprovalMail({
  po,
  to = [],
  routing = {},
  triggerLevel = Constants.TRIGGER_APPROVAL_LEVEL,
  rejectedLevel = 0,
  environment = 'DEV',
  logoAvailable = false,
  runStamp = '',
  degraded = false,
  dryRun = false,
  decision = null,
  greeting = '',
  notificationType = 'APPROVAL'
} = {}) {
  const prefix = Constants.SUBJECT_PREFIX ? `${Constants.SUBJECT_PREFIX} ` : '';
  const notification = String(notificationType).toUpperCase();
  const isCompleted = notification === 'COMPLETED';
  const isRejected = notification === 'REJECTED';
  const subject = isRejected
    ? `${prefix}PO ${po.poNumber} - Rejected | Company ${po.companyCode || '-'} | ${po.documentType || '-'}`
    : isCompleted
      ? `${prefix}PO ${po.poNumber} - Approved at All Levels | Company ${po.companyCode || '-'} | ${po.documentType || '-'}`
      : triggerLevel === 1
        ? `${prefix}PO ${po.poNumber} created - Approval Required (Level 1) | Company ${po.companyCode || '-'} | ${po.documentType || '-'}`
        : `${prefix}PO ${po.poNumber} - Approval Required (Level ${triggerLevel}) | Company ${po.companyCode || '-'} | ${po.documentType || '-'}`;

  const defaultGreeting = isRejected
    ? `This purchase order was rejected in SAP S/4HANA My Inbox. The approval workflow has stopped; no further approval-level notifications will be sent.`
    : isCompleted
      ? `All configured approval levels have been completed in SAP S/4HANA My Inbox. The purchase order is fully approved.`
      : triggerLevel === 1
        ? `A new purchase order has been created in S/4HANA and is waiting for your approval at <b>Level 1</b> of the approval flow. The complete purchase order details are listed below.`
        : `The S/4HANA workflow has advanced. This purchase order is awaiting review at <b>Level ${triggerLevel}</b>. Please complete the approval in S/4HANA My Inbox.`;
  const greetingHtml = greeting || (defaultGreeting +
    (dryRun ? '<br><br><b style="color:#b06000;">DRY RUN — this mail was not sent.</b>' : ''));

  const documentSection = section({
    title: 'Purchase Order Details',
    accent: '#0b2d5b',
    rowsHtml: [
      kvRow('PO Number', orDash(po.poNumber), { strong: true }),
      ...(isRejected ? [kvRow(
        'PO Status',
        '<span style="display:inline-block;background:#fde8e7;color:#b3261e;font-weight:bold;padding:3px 10px;border-radius:12px;">REJECTED</span>',
        { strong: true }
      )] : []),
      kvRow('Date (Created On)', orDash(po.createdOn)),
      kvRow('Document Type', orDash(po.documentType)),
      kvRow('Currency', orDash(po.currency)),
      kvRow('Payment Terms', 'As per Remarks'),
      kvRow('Purchasing Organization', orDash(po.purchasingOrganization)),
      kvRow('Purchasing Group', orDash(po.purchasingGroup)),
      kvRow('Created By', orDash(po.createdBy))
    ].join('')
  });

  const companySection = section({
    title: 'Company Details',
    accent: '#00838f',
    rowsHtml: [
      kvRow('Company Code', orDash(po.companyCode)),
      kvRow('Company Name', rawOrDash(po.companyName)),
      kvRow('Company Address', `<span style="white-space:pre-line;">${escapeMultiline(po.companyAddress)}</span>`)
    ].join('')
  });

  const supplierSection = section({
    title: 'Supplier Details',
    accent: '#e65100',
    rowsHtml: [
      kvRow('Supplier Code / Supplier', orDash(po.supplierCode)),
      kvRow('Supplier Name', orDash(po.supplierName), { strong: true }),
      kvRow('Supplier Address', `<span style="white-space:pre-line;">${escapeMultiline(po.supplierAddress)}</span>`),
      kvRow('Supplier Tax Number', orDash(po.supplierTaxNumber))
    ].join('')
  });

  const remarksContent = String(po.headerText ?? '').trim()
    ? escapeMultiline(po.headerText)
    : '<span style="color:#9aa0a6;">&mdash;</span>';
  const remarksSection = `<tr>
<td style="padding:18px 40px 0 40px;">
<div style="background:#fff8e5;border-left:6px solid #f39c12;border-radius:4px;padding:14px 18px;">
<div style="font-size:14px;font-weight:bold;color:#9a6b00;text-transform:uppercase;letter-spacing:0.5px;">Remarks (Header Text)</div>
<div style="font-size:13px;color:#444444;line-height:21px;margin-top:8px;white-space:pre-line;">${remarksContent}</div>
</div>
</td>
</tr>`;

  // Approval is performed only in SAP S/4HANA My Inbox. Never embed an
  // Outlook card or email action, even if a legacy caller supplies `decision`.
  const actionableCardJson = '';
  const actionableFlowNote = isRejected
    ? `<tr><td style="padding:18px 40px 0 40px;"><div style="border-left:6px solid #b3261e;background:#fde8e7;padding:12px 16px;color:#7f1d1d;font-size:13px;">Rejection is recorded in SAP S/4HANA My Inbox. This email is notification-only; the workflow is stopped and no approval action is available in this email.</div></td></tr>`
    : isCompleted
      ? `<tr><td style="padding:18px 40px 0 40px;"><div style="border-left:6px solid #2e7d32;background:#e8f5e9;padding:12px 16px;color:#245b28;font-size:13px;">This is a notification only. All configured approval levels are complete in SAP S/4HANA My Inbox. No approval action is available in this email.</div></td></tr>`
      : `<tr><td style="padding:18px 40px 0 40px;"><div style="border-left:6px solid #b06000;background:#fff8e5;padding:12px 16px;color:#704600;font-size:13px;">This email is a notification only. Review and complete the approval in SAP S/4HANA My Inbox; approval actions are not available in this email.</div></td></tr>`;

  const html = shell({
    logoAvailable,
    environment,
    po,
    headline: isRejected
      ? `Purchase Order ${po.poNumber} has been rejected`
      : isCompleted
        ? `Purchase Order ${po.poNumber} has been approved at all levels`
        : triggerLevel === 1
          ? `Purchase Order ${po.poNumber} has been created`
          : `Purchase Order ${po.poNumber} is awaiting Level ${triggerLevel} approval`,
    bannerTitle: isRejected
      ? 'Purchase Order Rejected'
      : isCompleted ? 'Purchase Order Approval Completed' : 'Purchase Order Approval Request',
    greetingHtml,
    actionableCardJson,
    bodyHtml: [
      remarksSection,
      documentSection,
      companySection,
      supplierSection,
      itemsSection(po),
      netValueSection(po),
      actionableFlowNote,
      launchpadButton(),
      approvalSection({ routing, triggerLevel, completed: isCompleted, rejected: isRejected, rejectedLevel })
    ].filter(Boolean).join('\n')
  });

  return { subject, html };
}

/** Compact red mail when a PO exists but could not be routed / mailed. */
function buildPoMailFailureMail({ poNumber = '', companyCode = '', documentType = '', error = '', environment = 'DEV', runStamp = '' } = {}) {
  const subject = `PO ${poNumber || '(unknown)'} – Approval Mail Could Not Be Sent`;
  const html = shell({
    logoAvailable: false,
    environment,
    po: { poNumber: poNumber || '(unknown)' },
    greetingHtml: 'A purchase order was created, but the approval mail could not be delivered. Please check the routing configuration.',
    bodyHtml: section({
      title: 'Failure Details',
      accent: '#dc3545',
      rowsHtml: [
        kvRow('PO Number', orDash(poNumber)),
        kvRow('Company Code', orDash(companyCode)),
        kvRow('Document Type', orDash(documentType)),
        kvRow('Error', `<span style="color:#dc3545;">${escapeMultiline(error)}</span>`)
      ].join('')
    })
  });
  return { subject, html };
}

module.exports = {
  buildPoApprovalMail,
  buildPoMailFailureMail,
  escapeHtml,
  orDash
};