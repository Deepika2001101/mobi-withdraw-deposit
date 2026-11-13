'use strict';

/** Build an Outlook Actionable Message card for the CAP-only approval flow. */
const Constants = require('../constants/PoConstants');

function action(url, title, token, intent) {
  return {
    type: 'Action.Http',
    title,
    method: 'POST',
    url,
    headers: [
      // Outlook puts its Microsoft-signed action JWT in Action-Authorization.
      { name: 'Authorization', value: '' },
      { name: 'Content-Type', value: 'application/json' }
    ],
    body: JSON.stringify({ token, intent })
  };
}

function flowItems(approvalFlow, currentLevel, phase, result) {
  const flow = Array.isArray(approvalFlow) ? approvalFlow : [];
  if (!flow.length) return [];

  const approvedThrough = phase === 'complete' && result?.action === 'approve'
    ? Number(currentLevel)
    : Number(currentLevel) - 1;
  const nextLevel = phase === 'complete' ? Number(result?.nextLevel) || 0 : Number(currentLevel);
  const mailFailed = phase === 'complete' && result?.status === 'APPROVED_MAIL_FAILED';

  return [
    { type: 'TextBlock', text: 'Approval Flow', weight: 'Bolder', spacing: 'Medium', wrap: true },
    ...flow.map((entry) => {
      const level = Number(entry.level) || 0;
      let status = level <= approvedThrough ? 'APPROVED' : 'PENDING';
      if (level === nextLevel) status = mailFailed ? 'NEXT-LEVEL EMAIL FAILED' : 'ACTION REQUIRED';
      const color = status === 'APPROVED' ? 'Good' : status === 'ACTION REQUIRED' ? 'Accent' : status.includes('FAILED') ? 'Attention' : 'Default';
      const recipients = (entry.recipients || []).join(', ') || 'No approver configured';
      return {
        type: 'Container',
        spacing: 'Small',
        items: [
          { type: 'TextBlock', text: `Level ${level} — ${status}`, weight: 'Bolder', color, wrap: true },
          { type: 'TextBlock', text: recipients, size: 'Small', color: 'Default', wrap: true, spacing: 'None' }
        ]
      };
    })
  ];
}

function build({ phase = 'pending', token, po = {}, level = 1, expectedActors = [], approvalFlow = [], result = null } = {}) {
  const card = {
    $schema: 'https://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.0',
    originator: Constants.ACTIONABLE_ORIGINATOR,
    expectedActors: (expectedActors || []).map((email) => String(email).trim().toLowerCase()).filter(Boolean),
    body: [
      {
        type: 'TextBlock',
        text: phase === 'confirm' ? 'Confirm purchase order approval' :
          phase === 'complete' ? `Level ${level} approval result` : 'Purchase order approval required',
        weight: 'Bolder',
        size: 'Medium',
        wrap: true
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'PO Number', value: String(po.poNumber || result?.poNumber || '-') },
          { title: 'Company Code', value: String(po.companyCode || result?.companyCode || '-') },
          { title: 'Document Type', value: String(po.documentType || '-') },
          { title: 'Approval Level', value: String(level) }
        ]
      },
      {
        type: 'TextBlock',
        text: phase === 'confirm'
          ? `Do you want to approve PO ${po.poNumber || ''}?`
          : phase === 'complete'
            ? String(result?.message || `Level ${level} approval recorded.`)
            : `Please review PO ${po.poNumber || ''}. Approving records this level in the CAP mail approval flow and notifies the next level. This does not update the official S/4HANA workflow status.`,
        wrap: true
      },
      ...flowItems(approvalFlow, level, phase, result)
    ],
    actions: []
  };

  if (phase === 'pending') {
    card.actions.push(action(`${Constants.PUBLIC_URL}${Constants.ACTION_ROUTE}`, 'Approve', token, 'confirm'));
  } else if (phase === 'confirm') {
    card.actions.push(action(`${Constants.PUBLIC_URL}${Constants.ACTION_ROUTE}`, 'Yes, approve', token, 'approve'));
    card.actions.push(action(`${Constants.PUBLIC_URL}${Constants.ACTION_ROUTE}`, 'No, go back', token, 'cancel'));
  }

  return card;
}

module.exports = { build };