'use strict';

/**
 * Reads purchase orders from S/4HANA over OData using the destination
 * S4HANA_MOBI — the same destination pattern as reversal/services/S4ReversalClient.js.
 *
 * Supported shapes (auto-detected per response, no configuration needed):
 *   OData V2   { d: { results: [...] , __next } }
 *   OData V4   { value: [...], @odata.nextLink }
 *
 * The PO CDS view name / entity path comes from PoConstants.ENTITY_PATH
 * (env: PO_MAIL_ENTITY_PATH). Field *names* are not interpreted here at all —
 * that is PoFieldMapper's job, so a CDS change never touches this client.
 */

const { getDestination } = require('@sap-cloud-sdk/connectivity');
const Constants = require('../constants/PoConstants');

class S4PoClient {
  constructor({
    destinationName = Constants.S4_DESTINATION,
    entityPath = Constants.ENTITY_PATH,
    itemPath = Constants.ITEM_PATH,
    odataVersion = Constants.ODATA_VERSION,
    pageSize = Constants.PAGE_SIZE,
    maxPages = Constants.MAX_PAGES
  } = {}) {
    this.destinationName = destinationName;
    this.entityPath = entityPath;
    this.itemPath = itemPath;
    this.odataVersion = String(odataVersion).toUpperCase() === 'V4' ? 'V4' : 'V2';
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    /** null = not resolved yet, '' = resolved and the view has no navigation. */
    this._navProperties = null;
    this._expandClauseResolved = this.itemPath ? this.itemPath : null;
  }

  /* ── public ─────────────────────────────────────────────────────────── */

  /**
   * Fetch PO headers created in [fromDate, toDate).
   * @returns {Promise<{rows:Array, range:object, degraded:boolean, truncated:boolean}>}
   *   degraded=true when the date filter was rejected by the service and the
   *   query fell back to "most recent POs" (still safe — the caller de-dupes).
   *   truncated=true when the CreationDate window was NOT fully read (page
   *   safety ceiling reached) — the caller must hold the run watermark so
   *   unread POs are retried on the next tick instead of being skipped.
   */
  async getPurchaseOrders({ fromDate, toDate, purchaseOrder = '', companyCode = '', documentType = '', firstPageOnly = false } = {}) {
    const destination = await this._getDestination();

    if (purchaseOrder) {
      const payload = await this._getJson(this._buildSinglePoUrl(destination.url, purchaseOrder), destination);
      return { rows: this._extractRows(payload), range: null, degraded: false, truncated: false };
    }

    const range = this._buildRange(fromDate, toDate);
    try {
      const rows = await this._fetchAll(destination, range, companyCode, documentType, true, firstPageOnly);
      return { rows, range, degraded: false, truncated: Boolean(this.lastFetchTruncated) };
    } catch (error) {
      // A CDS view that does not expose CreationDate (or a differently named
      // date property) rejects the $filter. Fall back to the newest POs by
      // sort order instead of failing the whole run — duplicates are blocked
      // downstream by the mail log.
      console.warn(
        `[S4PoClient] Filtered query failed (${error.message}). ` +
        `Retrying without the date filter, relying on duplicate-send protection.`
      );
      const rows = await this._fetchAll(destination, range, companyCode, documentType, false, firstPageOnly);
      return { rows, range, degraded: true, truncated: Boolean(this.lastFetchTruncated) };
    }
  }

  /**
   * Stream purchase orders page-by-page, processing each page via a callback
   * and discarding rows before reading the next page. Keeps memory bounded to
   * one page instead of accumulating all rows (which caused OOM kills when
   * reading 79+ pages / 78K+ rows).
   *
   * @param {Function} pageProcessor  async (pageRows, pageNumber) => void
   * @returns {Promise<{range:object, degraded:boolean, truncated:boolean}>}
   */
  async getPurchaseOrdersPaged({ fromDate, toDate, companyCode = '', documentType = '', pageProcessor } = {}) {
    const destination = await this._getDestination();
    const range = this._buildRange(fromDate, toDate);
    try {
      await this._fetchAll(destination, range, companyCode, documentType, true, false, pageProcessor);
      return { range, degraded: false, truncated: Boolean(this.lastFetchTruncated) };
    } catch (error) {
      console.warn(
        `[S4PoClient] Filtered streaming query failed (${error.message}). ` +
        `Retrying without the date filter, relying on duplicate-send protection.`
      );
      await this._fetchAll(destination, range, companyCode, documentType, false, false, pageProcessor);
      return { range, degraded: true, truncated: Boolean(this.lastFetchTruncated) };
    }
  }

  /**
   * Batch-read workflow status for multiple POs in ONE OData call instead of
   * one call per PO. The poll previously called getPurchaseOrders once per
   * active PO (N+1 calls), which added minutes when hundreds of POs were in
   * workflow. This reads all requested POs in a single $filter request
   * (eq/or chain — the service rejects the `in` operator), grouped by PO
   * number downstream.
   *
   * @param {string[]} poNumbers  array of PO numbers to fetch
   * @returns {Promise<Array>} flat rows grouped by PO number
   */
  async getPurchaseOrdersBatch(poNumbers, { companyCode = '', documentType = '' } = {}) {
    const numbers = (Array.isArray(poNumbers) ? poNumbers : [])
      .filter(Boolean)
      .map(String);
    if (!numbers.length) return [];

    const destination = await this._getDestination();
    // The tenant's OData service raises SYSTEM_NO_ROLL (HTTP 500) when the
    // eq/or $filter chain is too long, so read in small chunks instead of
    // one request for every active PO. Each chunk keeps the filter tiny; a
    // chunk that still fails falls back to per-PO reads.
    const BATCH_CHUNK = 5;
    const grouped = [];
    for (let i = 0; i < numbers.length; i += BATCH_CHUNK) {
      const chunk = numbers.slice(i, i + BATCH_CHUNK);
      let rows = [];
      try {
        const url = this._buildBatchUrl(destination.url, chunk, companyCode, documentType);
        const payload = await this._getJson(url, destination);
        rows = this._extractRows(payload);
      } catch (error) {
        console.warn(
          `[S4PoClient] Batch read chunk of ${chunk.length} PO(s) failed (${error.message}); ` +
          'falling back to per-PO reads for this chunk.'
        );
        for (const poNumber of chunk) {
          try {
            const single = await this.getPurchaseOrders({ purchaseOrder: poNumber, companyCode, documentType });
            rows.push(...(single.rows || []));
          } catch (singleError) {
            console.warn(
              `[S4PoClient] Per-PO fallback read failed for PO ${poNumber}: ${singleError.message}`
            );
          }
        }
      }
      grouped.push(...this._groupByPoNumber(rows));
    }
    return grouped;
  }

  _buildBatchUrl(destinationUrl, poNumbers, companyCode, documentType) {
    const url = new URL(this._baseUrl(destinationUrl));
    // The YY1_PO_EMAIL_CDS service rejects the `in (...)` operator in $filter
    // ("Invalid token detected"), so build an explicit eq/or chain. The chain
    // is parenthesised so the optional CompanyCode/PurchaseOrderType `and`
    // filters bind to ALL clauses, not just the last one.
    const orClauses = poNumbers.map((n) => `PurchaseOrder eq '${this._escape(n)}'`);
    const filter = `(${orClauses.join(' or ')})`;
    if (companyCode) filter += ` and CompanyCode eq '${this._escape(companyCode)}'`;
    if (documentType) filter += ` and PurchaseOrderType eq '${this._escape(documentType)}'`;
    const params = { $format: 'json', $filter: filter };
    // No $expand: the poll only needs header fields (workflow counters,
    // status), not line items. Skipping $expand keeps the response small
    // and fast, even for POs with 999 line items.
    const sortDateField = Constants.CREATED_ON_FIELD;
    params.$orderby = `${sortDateField} desc,PurchaseOrder desc`;
    url.search = new URLSearchParams(params).toString();
    return url.toString();
  }

  /**
   * Read authoritative S/4 processing status from the standard PO API.
   * The custom YY1 PO view may not expose this property; rejection handling
   * fails closed if this read is unavailable rather than treating a rejection
   * task-count change as an approval.
   */
  async getPurchaseOrderProcessingStatus(purchaseOrder) {
    if (!purchaseOrder) throw new Error('getPurchaseOrderProcessingStatus requires a PO number');
    const destination = await this._getDestination();
    const url = new URL(this._baseUrl(destination.url, Constants.PURCHASE_ORDER_API_PATH));
    const escape = (value) => String(value ?? '').replace(/'/g, "''");
    url.searchParams.set('$select', `PurchaseOrder,${Constants.PROCESSING_STATUS_FIELD}`);
    url.searchParams.set('$filter', `PurchaseOrder eq '${escape(purchaseOrder)}'`);
    url.searchParams.set('$top', '1');
    const payload = await this._getJson(url.toString(), destination);
    const row = this._extractRows(payload).find((entry) =>
      String(entry?.PurchaseOrder || '') === String(purchaseOrder)
    ) || this._extractRows(payload)[0];
    return row?.[Constants.PROCESSING_STATUS_FIELD]
      ?? row?.PurchasingProcessingStatus
      ?? '';
  }

  /** Fetch one PO with its items ($expand) — used by the on-demand action. */
  async getPurchaseOrder(purchaseOrder) {
    if (!purchaseOrder) throw new Error('getPurchaseOrder requires a PO number');
    const result = await this.getPurchaseOrders({ purchaseOrder });
    const rows = result.rows;
    if (!rows.length) throw new Error(`Purchase order ${purchaseOrder} not found on ${this.destinationName}`);
    return rows[0];
  }

  /**
   * Batch-read authoritative processing status for multiple POs in ONE call
   * to the standard PO API (API_PURCHASEORDER_2). Returns a Map of
   * poNumber -> status string. Replaces the per-PO getPurchaseOrderProcessingStatus
   * calls that added N sequential API round-trips to the poll.
   */
  async getPurchaseOrdersProcessingStatusBatch(poNumbers) {
    const numbers = (Array.isArray(poNumbers) ? poNumbers : [])
      .filter(Boolean)
      .map(String);
    const result = new Map();
    if (!numbers.length) return result;

    const destination = await this._getDestination();
    const escape = (value) => String(value ?? '').replace(/'/g, "''");
    // Chunk like getPurchaseOrdersBatch: long eq/or chains raise
    // SYSTEM_NO_ROLL (HTTP 500) on this tenant. A failing chunk falls back
    // to per-PO reads.
    const BATCH_CHUNK = 5;
    for (let i = 0; i < numbers.length; i += BATCH_CHUNK) {
      const chunk = numbers.slice(i, i + BATCH_CHUNK);
      let rows = [];
      try {
        const url = new URL(this._baseUrl(destination.url, Constants.PURCHASE_ORDER_API_PATH));
        const orClauses = chunk.map((n) => `PurchaseOrder eq '${escape(n)}'`);
        url.searchParams.set('$select', `PurchaseOrder,${Constants.PROCESSING_STATUS_FIELD}`);
        url.searchParams.set('$filter', orClauses.join(' or '));
        url.searchParams.set('$format', 'json');
        url.searchParams.set('$top', String(chunk.length));
        const payload = await this._getJson(url.toString(), destination);
        rows = this._extractRows(payload);
      } catch (error) {
        console.warn(
          `[S4PoClient] Batch status chunk of ${chunk.length} PO(s) failed (${error.message}); ` +
          'falling back to per-PO reads for this chunk.'
        );
        for (const poNumber of chunk) {
          try {
            const status = await this.getPurchaseOrderProcessingStatus(poNumber);
            if (status) result.set(poNumber, String(status).trim());
          } catch (singleError) {
            console.warn(
              `[S4PoClient] Per-PO status fallback failed for PO ${poNumber}: ${singleError.message}`
            );
          }
        }
        continue;
      }
      for (const row of rows) {
        const poNum = String(row?.PurchaseOrder || '');
        if (!poNum) continue;
        const status = row?.[Constants.PROCESSING_STATUS_FIELD]
          ?? row?.PurchasingProcessingStatus
          ?? '';
        result.set(poNum, String(status).trim());
      }
    }
    return result;
  }

  /**
   * Read the configured header Remarks text from API_PURCHASEORDER_2.
   * The entity has one row per PO + TextObjectType + Language; defaults are
   * F01 / EN and can be overridden with PO_MAIL_NOTE_TEXT_TYPE / LANGUAGE.
   * Returns '' when the selected note does not exist or has no PlainLongText.
   */
  async getPurchaseOrderRemarks(purchaseOrder) {
    if (!purchaseOrder) return '';

    const destination = await this._getDestination();
    const url = new URL(this._baseUrl(destination.url, Constants.PURCHASE_ORDER_NOTE_PATH));
    const escape = (value) => String(value ?? '').replace(/'/g, "''");
    const po = escape(purchaseOrder);
    const textType = escape(Constants.PURCHASE_ORDER_NOTE_TEXT_TYPE);
    const language = escape(Constants.PURCHASE_ORDER_NOTE_LANGUAGE);

    url.searchParams.set('$format', 'json');
    url.searchParams.set('$select', 'PurchaseOrder,TextObjectType,Language,PlainLongText');
    // Retrieve this PO's header notes, then prefer the configured text type
    // and language. If either differs on this PO, fall back to another
    // non-empty header note rather than losing the Remarks value.
    url.searchParams.set('$filter', `PurchaseOrder eq '${po}'`);

    const payload = await this._getJson(url.toString(), destination);
    const rows = this._extractRows(payload).filter((entry) =>
      String(entry?.PurchaseOrder || '') === String(purchaseOrder) &&
      String(entry?.PlainLongText ?? '').trim()
    );
    const row = rows.find((entry) =>
      String(entry?.TextObjectType || '') === textType &&
      String(entry?.Language || '') === language
    ) || rows.find((entry) =>
      String(entry?.TextObjectType || '') === textType
    ) || rows.find((entry) =>
      String(entry?.Language || '') === language
    ) || rows[0];

    if (!row) {
      console.warn(
        `[S4PoClient] No non-empty PurchaseOrderNote PlainLongText found for PO ${purchaseOrder} ` +
        `(${this._extractRows(payload).length} note row(s) returned).`
      );
      return '';
    }
    return String(row.PlainLongText).trim();
  }

  /* ── destination + auth ─────────────────────────────────────────────── */

  async _getDestination() {
    const destination = await getDestination({ destinationName: this.destinationName });
    if (!destination?.url) {
      throw new Error(`Destination ${this.destinationName} has no URL`);
    }
    return destination;
  }

  _buildHeaders(destination) {
    const headers = {
      Accept: 'application/json',
      'sap-language': 'EN'
    };

    const authToken = destination.authTokens?.[0];
    if (authToken?.value) {
      headers.Authorization = `${authToken.type || 'Bearer'} ${authToken.value}`;
    } else {
      const username = destination.username || destination.originalProperties?.User;
      const password = destination.password || destination.originalProperties?.Password;
      if (username && password) {
        headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      }
    }
    return headers;
  }

  /* ── URL building ───────────────────────────────────────────────────── */

  _baseUrl(destinationUrl, path = this.entityPath) {
    const base = new URL(`${String(destinationUrl).replace(/\/+$/, '')}/`);
    return new URL(String(path).replace(/^\/+/, ''), base).toString().replace(/\/$/, '');
  }

  _buildRange(fromDate, toDate) {
    if (!fromDate) return null;
    const field = Constants.CREATED_ON_FIELD;
    const literal = this.odataVersion === 'V4'
      ? (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z')
      : (date) => date.toISOString().replace('Z', '').replace(/\.\d{3}$/, '');
    return {
      field,
      fromLiteral: literal(fromDate),
      toLiteral: toDate ? literal(toDate) : null,
      fromDate,
      toDate
    };
  }

  _buildFilter(range, companyCode, documentType, withDate) {
    const conditions = [];
    if (withDate && range) {
      conditions.push(`${range.field} ge ${this._literal(range, range.fromLiteral)}`);
      if (range.toLiteral) conditions.push(`${range.field} lt ${this._literal(range, range.toLiteral)}`);
    }
    if (companyCode) conditions.push(`CompanyCode eq '${this._escape(companyCode)}'`);
    if (documentType) conditions.push(`PurchaseOrderType eq '${this._escape(documentType)}'`);
    return conditions.join(' and ');
  }

  _literal(range, value) {
    return this.odataVersion === 'V4' ? value : `datetime'${value}'`;
  }

  _escape(value) {
    return String(value ?? '').replace(/'/g, "''");
  }

  _buildListUrl(destinationUrl, { range, companyCode, documentType, withDate, skipToken = '', skip = null }) {
    const url = new URL(this._baseUrl(destinationUrl));
    const params = { $format: 'json', $top: String(this.pageSize) };

    const filter = this._buildFilter(range, companyCode, documentType, withDate);
    if (filter) params.$filter = filter;

    const expand = this._expandClause();
    if (expand) params.$expand = expand;

    // Sort by date, then PO number, for deterministic results when CreationDate
    // is date-only and multiple POs share midnight. This ordering is also
    // applied to the no-date fallback so the first page still favors recent POs.
    const sortDateField = range?.field || Constants.CREATED_ON_FIELD;
    params.$orderby = `${sortDateField} desc,PurchaseOrder desc`;
    if (skipToken) params.$skiptoken = skipToken;
    if (skip !== null && skip !== undefined && skip !== '') params.$skip = String(skip);

    url.search = new URLSearchParams(params).toString();
    return url.toString();
  }

  /**
   * $expand clause for the item navigation.
   *
   * ITEM_PATH configured  -> used as-is, no extra round trip.
   * ITEM_PATH empty (AUTO)-> read the service $metadata once, cache every
   *   NavigationProperty of the PO entity type and expand it. A flat view such
   *   as YY1_PO_EMAIL (one row per item, no association) simply resolves to ''
   *   and the rows are grouped by PO number downstream.
   */
  _expandClause() {
    return this._expandClauseResolved || '';
  }

  /**
   * Service $metadata URL. The entity set is the LAST path segment, so the
   * service root is everything before it:
   *   /sap/opu/odata/sap/YY1_PO_EMAIL_CDS/YY1_PO_EMAIL
   *   -> /sap/opu/odata/sap/YY1_PO_EMAIL_CDS/$metadata
   */
  _metadataUrl(destinationUrl) {
    const entityPath = String(this.entityPath).replace(/^\/+/, '').replace(/\/+$/, '');
    const cut = entityPath.lastIndexOf('/');
    const servicePath = cut > 0 ? entityPath.slice(0, cut) : entityPath;
    return `${this._baseUrl(destinationUrl, servicePath)}/$metadata`;
  }

  /**
   * Discover the navigation properties of the PO entity type from $metadata.
   * Best-effort: any failure degrades to "no expand" (flat grouping still works).
   */
  async _discoverExpand(destinationUrl, destination) {
    if (this._expandClauseResolved !== null) return this._expandClauseResolved;
    try {
      const url = this._metadataUrl(destinationUrl);
      const response = await fetch(url, {
        method: 'GET',
        headers: { ...this._buildHeaders(destination), Accept: 'application/xml,text/xml' }
      });
      if (!response.ok) throw new Error(`$metadata returned HTTP ${response.status}`);
      const xml = await response.text();

      // Entity set -> entity type
      const setPath = String(this.entityPath).replace(/^\/+/, '');
      const setName = setPath.slice(setPath.lastIndexOf('/') + 1);
      const setMatch = new RegExp(
        `<EntitySet[^>]*Name="${setName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*EntityType="[^"]*?([A-Za-z0-9_]+)"`
      ).exec(xml);
      const typeName = setMatch ? setMatch[1] : setName;

      // NavigationProperty names inside that EntityType
      const typeMatch = new RegExp(
        `<EntityType[^>]*Name="${typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">([\\s\\S]*?)</EntityType>`
      ).exec(xml);
      const block = typeMatch ? typeMatch[1] : '';
      const nav = [...block.matchAll(/<NavigationProperty[^>]*Name="([^"]+)"/g)].map((m) => m[1]);

      this._navProperties = nav;
      this._expandClauseResolved = nav.join(',');
      console.log(
        `[S4PoClient] $metadata: entity set '${setName}' -> type '${typeName}', ` +
        `navigation properties: ${nav.length ? nav.join(', ') : '(none - flat view)'}`
      );
    } catch (error) {
      this._navProperties = [];
      this._expandClauseResolved = '';
      console.warn(
        `[S4PoClient] Could not read $metadata for the item navigation (${error.message}). ` +
        'Continuing without $expand - flat rows are grouped by PO number. ' +
        'Set PO_MAIL_ITEM_PATH explicitly to skip this discovery.'
      );
    }
    return this._expandClauseResolved;
  }

  /**
   * Resolve $expand lazily: the first page is read without it, and only when
   * that page carries no inline item rows do we spend a $metadata round trip.
   * A flat view (YY1_PO_EMAIL) therefore never pays for discovery at all.
   *
   * @returns {Promise<boolean>} true when the caller must re-read page 1 with
   *   the newly discovered $expand (navigation found that was not inlined)
   */
  async _resolveExpandAfterFirstPage(rows, destinationUrl, destination) {
    if (this._expandClauseResolved) return false;
    if (this._rowHasInlineItems(rows)) {
      this._expandClauseResolved = '';
      this._navProperties = [];
      console.log('[S4PoClient] Items already arrive inline on the PO rows - no $expand needed.');
      return false;
    }

    await this._discoverExpand(destinationUrl, destination);
    if (!this._expandClauseResolved) {
      console.log(
        '[S4PoClient] The view exposes no item navigation - treating it as a flat ' +
        'PO/item projection and grouping rows by PO number.'
      );
      return false;
    }

    // A navigation exists but its targets were not inlined -> re-read expanded.
    const inlined = (rows || []).some((row) => (this._navProperties || []).some((nav) => {
      const value = row?.[nav];
      return (Array.isArray(value) && value.length) || (Array.isArray(value?.results) && value.results.length);
    }));
    if (inlined) return false;

    console.log(`[S4PoClient] Re-reading page 1 with $expand=${this._expandClauseResolved}.`);
    return true;
  }

  /** True when a row already carries its items (expanded or auto-inlined). */
  _rowHasInlineItems(rows) {
    const list = Array.isArray(rows) ? rows : [rows];
    return list.some((row) => {
      if (!row || typeof row !== 'object') return false;
      return Object.keys(row).some((key) => {
        const value = row[key];
        return (Array.isArray(value) && value.length) || (Array.isArray(value?.results) && value.results.length);
      });
    });
  }

  _buildSinglePoUrl(destinationUrl, purchaseOrder) {
    // The YY1_PO_EMAIL CDS projection may have a composite or non-standard
    // OData key. A key-predicate URL such as /YY1_PO_EMAIL('5100000168') can
    // therefore fail in S/4 with "Duplicate resource". Query the entity set
    // by its exposed PurchaseOrder field instead; this also returns flat
    // PO/item projections as a collection for the normal grouping path.
    const url = new URL(this._baseUrl(destinationUrl));
    const params = {
      $format: 'json',
      $filter: `PurchaseOrder eq '${this._escape(purchaseOrder)}'`
    };
    const expand = this._expandClause();
    if (expand) params.$expand = expand;
    url.search = new URLSearchParams(params).toString();
    return url.toString();
  }

  /* ── paging ─────────────────────────────────────────────────────────── */

  async _fetchAll(destination, range, companyCode, documentType, withDate, firstPageOnly = false, pageProcessor = null) {
    const rows = [];
    let skipToken = '';
    let skip = null;
    let page = 0;
    let prevPageKey = '';
    let exhausted = false;
    // Rows processed so far — counts rows in BOTH modes. In stream mode the
    // `rows` array stays empty (rows are passed to the processor and
    // discarded), so the $skip offset MUST come from this counter, not from
    // rows.length (which would always be 0 and repeat page 1 forever).
    let processedRows = 0;
    this.lastFetchTruncated = false;

    while (page < this.maxPages) {
      page += 1;
      const url = this._buildListUrl(destination.url, { range, companyCode, documentType, withDate, skipToken, skip });
      const payload = await this._getJson(url, destination);
      const pageRows = this._extractRows(payload);
      if (!Array.isArray(pageRows)) {
        throw new Error(`Unexpected SAP purchase order response on page ${page}`);
      }
      // First page tells us whether the view delivers items inline, expanded,
      // or flat. Only a flat-looking page costs a $metadata discovery call —
      // and if that discovers a navigation, page 1 is re-read with $expand.
      if (page === 1) {
        const reread = await this._resolveExpandAfterFirstPage(pageRows, destination.url, destination);
        if (reread) {
          const expandedUrl = this._buildListUrl(destination.url, { range, companyCode, documentType, withDate, skipToken, skip });
          const expandedPayload = await this._getJson(expandedUrl, destination);
          const expandedRows = this._extractRows(expandedPayload);
          rows.length = 0;
          rows.push(...expandedRows);
          prevPageKey = expandedRows.length ? JSON.stringify(expandedRows) : '';
          // Fast-trigger read: page 1 (with $expand) is all we need to mail
          // the newest POs immediately. Stop here — intentionally not
          // truncated, since the caller asked for page 1 only.
          if (firstPageOnly) { exhausted = true; break; }
          // Stream mode: pass page 1 rows to the processor and discard.
          if (pageProcessor) { await pageProcessor(expandedRows, page); }
          processedRows += expandedRows.length;
          const expandedNext = this._extractNextPage(expandedPayload);
          if ((!expandedNext || !expandedNext.kind) && expandedRows.length < this.pageSize) break;
          if (expandedNext?.kind === 'token') { skipToken = expandedNext.value; skip = null; }
          else if (expandedNext?.kind === 'skip') { skip = expandedNext.value; skipToken = ''; }
          else { skip = processedRows; skipToken = ''; } // full page, no usable link -> offset paging
          page += 1;
          continue;
        }
        // Fast-trigger read: page 1 (no expand needed) is all we need.
        if (firstPageOnly) { exhausted = true; break; }
      }

      // Offset-fallback paging: before ACCEPTING a page, make sure the service
      // actually advanced. A service that ignores $skip re-sends the previous
      // page forever — compare the whole page (first-row alone would false-
      // positive on legitimately duplicated rows at a page boundary) and stop
      // BEFORE pushing so no duplicate enters the result set. The key is
      // recorded for EVERY page so page 1 participates in the comparison.
      const pageKey = JSON.stringify(pageRows);
      if (skip !== null && page > 1 && prevPageKey && pageKey === prevPageKey) {
        console.warn(
          `[S4PoClient] Page ${page} repeated the previous page — the service ignored $skip; ` +
          'stopping pagination. Older POs may stay unread.'
        );
        break;
      }
      prevPageKey = pageKey;

      // Stream mode: pass rows to the processor and discard immediately,
      // keeping memory bounded to one page. Otherwise accumulate as before.
      // processedRows tracks every row seen so far — the $skip offset for the
      // no-next-link fallback below. If the processor returns true, it has
      // hit its work cap and asks us to stop reading further pages.
      if (pageProcessor) {
        processedRows += pageRows.length;
        const stop = await pageProcessor(pageRows, page);
        if (stop) { exhausted = true; break; }
      } else {
        rows.push(...pageRows);
        processedRows += pageRows.length;
      }

      if (pageRows.length === 0) { exhausted = true; break; }

      // A service that hands back a next-page link uses it (token or offset).
      const next = this._extractNextPage(payload);
      if (next?.kind === 'token') {
        skipToken = next.value;
        skip = null;
        continue;
      }
      if (next?.kind === 'skip') {
        skip = next.value;
        skipToken = '';
        continue;
      }
      // No next link at all: some views omit it even though more rows exist.
      // Continue with $skip offset paging while pages keep coming back full.
      if (pageRows.length >= this.pageSize) {
        const offset = processedRows;
        console.log(`[S4PoClient] Page ${page}: full page with no next link — continuing with $skip=${offset}.`);
        skip = offset;
        skipToken = '';
        continue;
      }
      exhausted = true;
      break;
    }

    const truncated = !exhausted;
    this.lastFetchTruncated = truncated;
    if (truncated) {
      console.warn(
        `[S4PoClient] CreationDate window NOT fully read: stopped at ${page} page(s) / ${processedRows} row(s) ` +
        `(PO_MAIL_MAX_PAGES=${this.maxPages}). Unread POs stay in the window — this run will hold the ` +
        'watermark and retry them next tick (no PO is skipped). Fixing the YY1_PO_EMAIL view fan-out ' +
        'makes this ceiling unreachable.'
      );
    }
    console.log(`[S4PoClient] Read ${processedRows} purchase order row(s) in ${page} page(s) from ${this.destinationName}${truncated ? ' — TRUNCATED' : ''}.`);
    return rows;
  }

  _extractRows(payload) {
    if (!payload) return [];
    if (Array.isArray(payload.value)) return payload.value;               // V4 collection
    if (Array.isArray(payload.d?.results)) return payload.d.results;      // V2 collection
    if (Array.isArray(payload.d)) return payload.d;
    if (payload.d && typeof payload.d === 'object') return [payload.d];   // V2 single entity
    if (payload.value && typeof payload.value === 'object') return [payload.value];
    return [];
  }

  /**
   * Group flat PO rows (one row per item) by PO number.
   * Returns an array of grouped PO objects, each with a `rows` array
   * containing all its item rows. Used by the batch poll to map S/4
   * responses back to individual POs.
   */
  _groupByPoNumber(rows) {
    const map = new Map();
    for (const row of rows) {
      const poNum = row.PurchaseOrder || row.PurchaseOrderNumber || row.poNumber;
      if (!poNum) continue;
      if (!map.has(poNum)) map.set(poNum, { PurchaseOrder: poNum, rows: [] });
      map.get(poNum).rows.push(row);
    }
    return Array.from(map.values());
  }

  /**
   * Parse the next-page cursor from a list response.
   * @returns {{kind:'token',value:string}|{kind:'skip',value:number}|null}
   *   token -> OData $skiptoken; skip -> $skip offset; null -> no usable link.
   * Both V2 (__next) and V4 (@odata.nextLink) shapes are recognized, and the
   * link itself may carry either cursor style — older parsers accepted only
   * $skiptoken= and silently dropped $skip= links, truncating every read at
   * page 1.
   */
  _extractNextPage(payload) {
    const next = payload?.d?.__next || payload?.['@odata.nextLink'] || payload?.d?.['@odata.nextLink'];
    if (!next) return null;
    // The link may be raw or percent-encoded ($ -> %24) depending on the
    // service; accept both spellings. Decoding a malformed % sequence must
    // not throw — fall back to the raw link.
    let link = String(next);
    try { link = decodeURIComponent(link); } catch (_) { /* keep raw */ }
    const token = /\$skiptoken=([^&]+)/i.exec(link);
    if (token) return { kind: 'token', value: decodeURIComponent(token[1]) };
    const skip = /\$skip=(\d+)/i.exec(link);
    if (skip) return { kind: 'skip', value: Number(skip[1]) };
    return null;
  }

  /* ── HTTP ───────────────────────────────────────────────────────────── */

  async _getJson(url, destination) {
    const response = await fetch(url, { method: 'GET', headers: this._buildHeaders(destination) });
    const body = await response.text();

    let payload;
    try {
      payload = body ? JSON.parse(body) : {};
    } catch (_) {
      payload = null;
    }

    if (!response.ok) {
      const sapMessage = payload?.error?.message?.value || payload?.error?.message || body;
      throw new Error(`SAP purchase order OData request failed (${response.status}): ${String(sapMessage).slice(0, 800)}`);
    }
    if (!payload) {
      throw new Error('SAP purchase order OData response was not JSON. Check the destination URL, the CDS OData publication and the Accept header.');
    }
    return payload;
  }
}

module.exports = S4PoClient;