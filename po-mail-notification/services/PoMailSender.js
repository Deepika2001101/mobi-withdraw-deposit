'use strict';
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const Constants = require('../constants/PoConstants');
const { getPoSmtpConfig } = require('./PoSmtpDestination');

function mergeAddresses(...sources) {
  const merged = new Set();
  for (const source of sources) {
    if (!source) continue;
    const list = Array.isArray(source) ? source : String(source).split(',');
    for (const entry of list) {
      const address = String(entry || '').trim();
      if (address) merged.add(address);
    }
  }
  return merged.size ? [...merged].join(', ') : undefined;
}

class PoMailSender {
  /**
   * @param {object} [options]
   * @param {string} [options.destinationName] override SMTP_MOBI_PO_DEV
   * @param {object} [options.config]          pre-resolved destination config (saves a lookup)
   */
  constructor({ destinationName = Constants.SMTP_DESTINATION, config = null } = {}) {
    this.destinationName = destinationName;
    this._config = config;
    this._transporter = null;
    this._logoCache = null;
  }

  async config() {
    if (!this._config) this._config = await getPoSmtpConfig(this.destinationName);
    return this._config;
  }

  async transporter() {
    if (this._transporter) return this._transporter;
    const config = await this.config();
    this._transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTLS,
      auth: { user: config.user, pass: config.password }
    });
    return this._transporter;
  }

  async logoAttachment() {
    if (this._logoCache) return this._logoCache;

    const dir = path.isAbsolute(Constants.LOGO_DIR)
      ? Constants.LOGO_DIR
      : path.resolve(process.cwd(), Constants.LOGO_DIR);

    for (const extension of Constants.LOGO_SUPPORTED_EXTENSIONS) {
      const file = path.join(dir, `${Constants.LOGO_FILE_BASENAME}${extension}`);
      try {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file);
        if (!content?.length) continue;
        this._logoCache = {
          available: true,
          attachment: {
            cid: Constants.LOGO_CID,
            filename: path.basename(file),
            content,
            contentType: extension === '.png' ? 'image/png' : 'image/jpeg',
            encoding: 'base64'
          }
        };
        console.log(`[PoMailSender] Logo embedded from ${file} (${content.length} bytes).`);
        return this._logoCache;
      } catch (error) {
        console.warn(`[PoMailSender] Could not read logo ${file}: ${error.message}`);
      }
    }

    this._logoCache = { available: false, attachment: null };
    console.warn(
      `[PoMailSender] No logo found at ${dir}/${Constants.LOGO_FILE_BASENAME}.` +
      `{png,jpg,jpeg} — using the text banner instead.`
    );
    return this._logoCache;
  }

  /**
   * @param {object} args
   * @param {string|Array<string>} args.to  required — comma-separated string or array
   * @param {string} args.subject
   * @param {string} args.html
   * @param {string|Array<string>} [args.cc]
   * @param {string|Array<string>} [args.bcc]
   * @param {Array} [args.attachments]    extra attachments (logo is added automatically)
   * @param {boolean} [args.embedLogo]    default true
   * @param {boolean} [args.dryRun]       build + validate but do not send
   */
  async send({ to = [], cc = [], bcc = [], subject, html, attachments = [], embedLogo = true, dryRun = false } = {}) {
    try {
      const config = await this.config();
      const recipients = [...new Set(
        (Array.isArray(to) ? to : String(to || '').split(','))
          .map((entry) => String(entry || '').trim())
          .filter(Boolean)
      )];

      if (!recipients.length) {
        return { sent: false, error: 'No approver recipients resolved for this purchase order.' };
      }

      const allAttachments = [...attachments];
      let logoAvailable = false;
      if (embedLogo) {
        const logo = await this.logoAttachment();
        logoAvailable = logo.available;
        if (logo.attachment) allAttachments.push(logo.attachment);
      }

      const message = {
        from: config.fromName ? { name: config.fromName, address: config.from } : config.from,
        to: recipients.join(', '),
        cc: mergeAddresses(cc),
        bcc: mergeAddresses(bcc),
        subject,
        html,
        attachments: allAttachments
      };

      if (dryRun) {
        console.log(`[PoMailSender] DRY RUN — would send "${subject}" to ${message.to} (logo=${logoAvailable}).`);
        return { sent: false, dryRun: true, to: recipients, messageId: '', source: `${config.source} (dry run)`, logoAvailable };
      }

      const transport = await this.transporter();
      const info = await transport.sendMail(message);

      console.log(
        `[PoMailSender] Mail "${subject}" sent via ${config.source} to ${message.to}` +
        `${message.cc ? ` (cc=${message.cc})` : ''} (messageId=${info.messageId}).`
      );
      return {
        sent: true,
        messageId: info.messageId,
        to: recipients,
        cc: message.cc || '',
        source: config.source,
        logoAvailable
      };
    } catch (error) {
      console.error(`[PoMailSender] Failed to send mail "${subject}": ${error.message}`);
      return { sent: false, error: error.message };
    }
  }
}

module.exports = PoMailSender;