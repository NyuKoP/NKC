import { readEventEnvelope } from "../storage/storedPayload";
import { canonicalBytes } from "../crypto/canonicalJson";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { getSodium } from "../security/sodium";
import { computeEnvelopeHash, verifyEnvelopeSignature } from "../crypto/box";
import type { DeviceAuthorization } from "../devices/deviceApprovals";
import { decryptJsonRecord, encryptJsonRecord } from "../crypto/vault";
import { writeVault } from "../db/vaultAccess";
import type { ReceiveContext } from "../accounts/receiveContext";
import type { EventRecord } from "../db/schema";

export type HistoryPolicy = { v: 2; policy: "ALL" | "LAST_30_DAYS" | "NEW_ONLY"; fromTs: number };

export type HistoryBinding = {
  accountIdentity: string; requesterDeviceId: string; sourceDeviceId: string; sourceIdentityPub: string;
  sourceEpoch: number; requestId: string; scope: "global"; history: HistoryPolicy;
};

export type HistoryItem = { eventId: string; eventHash: string; deliveryId: string; bodyHash: string };

export type HistoryInventory = {
  v: 1; binding: HistoryBinding; snapshotId: string; count: number; totalPages: number; page: number; items: HistoryItem[];
};

type HistoryHeader = Omit<HistoryInventory, "page" | "items"> & { next: number };

type HistoryEvent = EventRecord | { eventId: string; envelopeJson: string };

const MAX_PAGES = 2048, MAX_ITEMS = 16;

export const HISTORY_MAX_ITEMS = MAX_PAGES * MAX_ITEMS;

const hash = async (value: unknown) => encodeBase64Url((await getSodium()).crypto_generichash(32, canonicalBytes(value)));

export const historyBodyHash = hash;

const headerKey = (channel: string, requestId: string) => `history_inventory_v1:${channel}:${requestId}`;

const pageKey = (key: string, page: number) => `${key}:page:${page}`;

const fail = () => { throw new Error("HISTORY_INVENTORY_CONFLICT"); };

export const buildHistoryInventory = async (binding: HistoryBinding, pages: HistoryEvent[][],
  bodyHashes: Map<string, string>): Promise<HistoryInventory[]> => {
  if (!pages.length || pages.length > MAX_PAGES || pages.some(page => page.length > MAX_ITEMS)) fail();

  const items = await Promise.all(pages.map(page => Promise.all(page.map(async event => {
    // SAFETY: the builder receives envelopes prepared by the existing send path.
    const envelope = readEventEnvelope(event);
    const deliveryId = envelope.header.deviceDelivery?.deliveryId, bodyHash = bodyHashes.get(event.eventId);

    if (!deliveryId || !bodyHash) return fail();

    return { eventId: event.eventId, eventHash: await computeEnvelopeHash(envelope), deliveryId, bodyHash };
  }))));

  const count = items.reduce((sum, page) => sum + page.length, 0);

  if (new Set(items.flat().map(item => item.eventId)).size !== count || new Set(items.flat().map(item => item.deliveryId)).size !== count) fail();
  const snapshotId = await hash({ binding, count, pages: await Promise.all(items.map(hash)) });

  return items.map((page, index) => ({ v: 1, binding, snapshotId, count, totalPages: pages.length, page: index, items: page }));
};

const read = async <T>(key: string, context: ReceiveContext) => {
  const row = await context.vault.db.meta.get(key);

  return { encoded: row?.value, value: row ? await decryptJsonRecord<T>(context.vault.key, key, "history-inventory", row.value) : undefined };
};

const declaration = (page: HistoryInventory): Omit<HistoryHeader, "next"> => ({
  v: page.v, binding: page.binding, snapshotId: page.snapshotId, count: page.count, totalPages: page.totalPages,
});

/** Called only after ordinary signed-control authentication and current device authorization. */
const prepareHistoryInventory = async (channel: string, page: HistoryInventory, expected: HistoryBinding,
  events: HistoryEvent[], context: ReceiveContext, certificate?: DeviceAuthorization) => {
  await context.vault.assertMain();

  if (page?.v !== 1 || !page.binding || await hash(page.binding) !== await hash(expected) ||
      !/^[A-Za-z0-9_-]{43}$/.test(page.snapshotId) || !Number.isSafeInteger(page.count) || page.count < 0 || page.count > MAX_PAGES * MAX_ITEMS ||
      !Number.isSafeInteger(page.totalPages) || page.totalPages < 1 || page.totalPages > MAX_PAGES ||
      !Number.isSafeInteger(page.page) || page.page < 0 || page.page >= page.totalPages ||
      !Array.isArray(page.items) || page.items.length > MAX_ITEMS || page.items.length > page.count ||
      page.items.some(item => !item || typeof item.eventId !== "string" || !item.eventId || item.eventId.length > 256 ||
        typeof item.deliveryId !== "string" || !item.deliveryId || item.deliveryId.length > 256 ||
        !/^[A-Za-z0-9_-]{43}$/.test(item.bodyHash) || !/^[A-Za-z0-9_-]{43}$/.test(item.eventHash)) ||
      new Set(page.items.map(item => item.eventId)).size !== page.items.length || new Set(page.items.map(item => item.deliveryId)).size !== page.items.length ||
      events.length > MAX_ITEMS || new Set(events.map(event => event.eventId)).size !== events.length) fail();

  const itemsByDelivery = new Map(page.items.map(item => [item.deliveryId, item]));

  for (const event of events) {
    // SAFETY: this untrusted envelope is checked against the authenticated binding and signature below.
    const envelope = readEventEnvelope(event);
    const item = itemsByDelivery.get(envelope.header.deviceDelivery?.deliveryId ?? "");

    if (!item || envelope.header.eventId !== event.eventId || envelope.header.convId !== channel ||
        envelope.header.authorDeviceId !== expected.sourceDeviceId || envelope.header.deviceDelivery?.recipientDeviceId !== expected.requesterDeviceId ||
        !certificate || await hash(envelope.header.deviceDelivery.author) !== await hash(certificate) ||
        !await verifyEnvelopeSignature(envelope, decodeBase64Url(expected.sourceIdentityPub)) ||
        item.eventId === event.eventId && item.eventHash !== await computeEnvelopeHash(envelope)) fail();
  }

  const key = headerKey(channel, expected.requestId), pkey = pageKey(key, page.page);
  const [before, previous] = await Promise.all([read<HistoryHeader>(key, context), read<HistoryItem[]>(pkey, context)]);

  if (before.value && await hash(declaration(page)) !== await hash({ ...before.value, next: undefined })) fail();

  if (previous.value && await hash(previous.value) !== await hash(page.items)) fail();
  const next: HistoryHeader = { ...declaration(page), next: 0 };

  const [encodedHeader, encodedPage] = await Promise.all([
    before.encoded ?? encryptJsonRecord(context.vault.key, key, "history-inventory", next),
    previous.encoded ?? encryptJsonRecord(context.vault.key, pkey, "history-inventory", page.items),
  ]);

  return { key, pkey, before: before.encoded, previous: previous.encoded, encodedHeader, encodedPage };
};

const commitInventories = async (plans: Awaited<ReturnType<typeof prepareHistoryInventory>>[], context: ReceiveContext) => {
  const records = new Map<string, { before: string | undefined; value: string }>();
  for (const plan of plans) {
    const prior = records.get(plan.key);
    if (prior && prior.before !== plan.before) fail();
    if (!prior) records.set(plan.key, { before: plan.before, value: plan.encodedHeader });
    records.set(plan.pkey, { before: plan.previous, value: plan.encodedPage });
  }
  await writeVault(context.vault, [context.vault.db.meta], async () => {
    for (const [key, record] of records) if ((await context.vault.db.meta.get(key))?.value !== record.before) fail();
    for (const [key, record] of records) if (record.before === undefined) await context.vault.db.meta.put({ key, value: record.value });
  });
};

/** Incoming pages retain their existing independent, durable gap/resume semantics. */
export const retainHistoryInventory = async (channel: string, page: HistoryInventory, expected: HistoryBinding,
  events: HistoryEvent[], context: ReceiveContext, certificate?: DeviceAuthorization) => {
  await commitInventories([await prepareHistoryInventory(channel, page, expected, events, context, certificate)], context);
};

/** A source must retain its entire immutable declaration before publishing any page. */
export const retainHistoryInventorySnapshot = async (channel: string, pages: HistoryInventory[], expected: HistoryBinding, context: ReceiveContext) => {
  await context.vault.assertMain();
  if (!pages.length || pages.length > MAX_PAGES) fail();
  const first = pages[0], items = pages.flatMap(page => page.items);
  if (pages.some((page, index) => page.page !== index || page.totalPages !== pages.length || page.snapshotId !== first.snapshotId || page.count !== first.count) ||
      items.length !== first.count || new Set(items.map(item => item.eventId)).size !== items.length ||
      new Set(items.map(item => item.deliveryId)).size !== items.length ||
      first.snapshotId !== await hash({ binding: expected, count: first.count, pages: await Promise.all(pages.map(page => hash(page.items))) })) fail();
  const plans = [];
  for (const page of pages) plans.push(await prepareHistoryInventory(channel, page, expected, [], context));
  await commitInventories(plans, context);
};

/** Exact encoded application-record bytes, not filesystem usage or an enforced quota. No plaintext scan or eviction. */
export const getHistoryStorageUsage = async (context: ReceiveContext) => {
  await context.vault.assertMain();
  const db = context.vault.db, encoder = new TextEncoder();
  const bytes = (value: string) => encoder.encode(value).byteLength;
  const usage = { snapshotHeaders: 0, snapshotPages: 0, metadataEncodedBytes: 0,
    eventRows: 0, eventRecordBytes: 0, outboxRows: 0, outboxRecordBytes: 0 };
  await db.transaction("r", [db.meta, db.events, db.outbox], async () => {
    await db.meta.where("key").between("history_inventory_v1:", "history_inventory_v1:\uffff", true, true).each(row => {
      if (/:page:\d+$/.test(row.key)) usage.snapshotPages++;
      else usage.snapshotHeaders++;
      usage.metadataEncodedBytes += bytes(row.key) + bytes(row.value);
    });
    // Includes original and wrapper Events and ordinary traffic; never mislabel this total as History-only cost.
    await db.events.each(row => { usage.eventRows++; usage.eventRecordBytes += bytes(JSON.stringify(row)); });
    await db.outbox.each(row => { usage.outboxRows++; usage.outboxRecordBytes += bytes(JSON.stringify(row)); });
  });
  await context.vault.assertMain();
  return usage;
};

const readPages = async (key: string, header: HistoryHeader, context: ReceiveContext) => {
  const keys = Array.from({ length: header.totalPages }, (_, page) => pageKey(key, page));
  const records = await context.vault.db.meta.bulkGet(keys);

  const pages = await Promise.all(records.map(async (row, index) => ({ encoded: row?.value,
    value: row ? await decryptJsonRecord<HistoryItem[]>(context.vault.key, keys[index], "history-inventory", row.value) : undefined,
  })));

  const present = pages.every(page => page.value !== undefined);

  if (present) {
    const all = pages.flatMap(page => page.value!);

    if (all.length !== header.count || new Set(all.map(item => item.eventId)).size !== all.length ||
        new Set(all.map(item => item.deliveryId)).size !== all.length ||
        header.snapshotId !== await hash({ binding: header.binding, count: header.count, pages: await Promise.all(pages.map(page => hash(page.value))) })) fail();
  }

  return { pages, present };
};

const replacementKey = (deliveryId: string, bodyHash: string) => `${deliveryId}:${bodyHash}`;

const storedReplacements = (channel: string, binding: HistoryBinding, items: HistoryItem[], context: ReceiveContext) => {
  let pending: Promise<Map<string, EventRecord>> | undefined;

  return () => pending ??= (async () => {
    const wanted = new Set(items.map(item => replacementKey(item.deliveryId, item.bodyHash)));
    const matches = new Map<string, EventRecord>();

    await context.vault.db.events.where("convId").equals(channel).each(row => {
      if (row.authorDeviceId !== binding.sourceDeviceId || row.applicationState !== "stored" ||
          !row.applicationCryptoCommitted || !row.applicationBodyHash) return;
      // SAFETY: stored envelopes passed application admission; current endpoint and body bindings are checked below.
      const envelope = readEventEnvelope(row);
      const delivery = envelope.header.deviceDelivery;

      if (!delivery?.deliveryId || delivery.recipientDeviceId !== binding.requesterDeviceId) return;
      const key = replacementKey(delivery.deliveryId, row.applicationBodyHash);

      if (wanted.has(key)) matches.set(key, row);
    });

    return matches;
  })();
};

const committed = async (item: HistoryItem, channel: string, context: ReceiveContext,
  event: EventRecord | undefined,
  replacements: () => Promise<Map<string, EventRecord>>) => {
  if (event && event.eventHash !== item.eventHash) return false;

  if (!event || event.applicationState !== "stored") {
    event = (await replacements()).get(replacementKey(item.deliveryId, item.bodyHash));
  }

  if (!event || event.convId !== channel || event.applicationState !== "stored" || !event.applicationCryptoCommitted ||
      !event.bodyType || event.authenticatedBody_enc || event.applicationBodyHash !== item.bodyHash) return false;

  if (event.bodyType === "msg") {
    // SAFETY: the final stored marker belongs to the authenticated application path.
    const envelope = readEventEnvelope(event);
    const message = await context.vault.db.messages.get(event.logicalMessageId ?? envelope.header.friendDeliveryId ?? event.eventId);

    if (!message || message.convId !== event.localConvId) return false;
  }

  return true;
};

export const storedHistoryDeliveries = async (channel: string, page: HistoryInventory, context: ReceiveContext) => {
  const load = storedReplacements(channel, page.binding, page.items, context);
  const stored = new Set<string>();
  const events = await context.vault.db.events.bulkGet(page.items.map(item => item.eventId));

  for (const [index, item] of page.items.entries()) if (await committed(item, channel, context, events[index], load)) stored.add(item.deliveryId);

  return stored;
};

/** Effects commit first; this short DB-only transaction can lag, but never lead, application storage. */
export const advanceHistoryInventory = async (channel: string, page: HistoryInventory, context: ReceiveContext) => {
  const key = headerKey(channel, page.binding.requestId), before = await read<HistoryHeader>(key, context);

  if (!before.value || before.value.snapshotId !== page.snapshotId || before.value.next < page.page) return false;
  const header = before.value, final = page.page === header.totalPages - 1;

  const selected = final ? await readPages(key, header, context) : {
    pages: [await read<HistoryItem[]>(pageKey(key, page.page), context)], present: true,
  };

  if (!selected.present || selected.pages.some(row => !row.value)) return false;
  const value = await encryptJsonRecord(context.vault.key, key, "history-inventory", { ...header, next: Math.max(header.next, page.page + 1) });

  return writeVault(context.vault, [context.vault.db.meta, context.vault.db.events, context.vault.db.messages], async () => {
    const load = storedReplacements(channel, header.binding, selected.pages.flatMap(row => row.value ?? []), context);

    if ((await context.vault.db.meta.get(key))?.value !== before.encoded) fail();

    for (let index = 0; index < selected.pages.length; index++) {
      const row = selected.pages[index], number = final ? index : page.page;

      if ((await context.vault.db.meta.get(pageKey(key, number)))?.value !== row.encoded) fail();

      const events = await context.vault.db.events.bulkGet((row.value ?? []).map(item => item.eventId));

      for (const [index, item] of (row.value ?? []).entries()) if (!await committed(item, channel, context, events[index], load)) return false;
    }

    await context.vault.db.meta.put({ key, value });

    return true;
  });
};

export const readHistoryInventory = async (channel: string, requestId: string, context: ReceiveContext) => {
  await context.vault.assertMain();
  const key = headerKey(channel, requestId), record = await read<HistoryHeader>(key, context);

  if (!record.value) return undefined;
  const { pages, present } = await readPages(key, record.value, context);
  const load = storedReplacements(channel, record.value.binding, pages.flatMap(row => row.value ?? []), context);
  const gaps: Array<{ eventId: string; state: "DECLARED_BUT_MISSING" | "DECLARED_BUT_PENDING" | "DECLARED_BUT_REJECTED" }> = [];

  for (const page of pages) {
    const items = page.value ?? [], events = await context.vault.db.events.bulkGet(items.map(item => item.eventId));

    for (const [index, item] of items.entries()) {
      if (await committed(item, channel, context, events[index], load)) continue;
      const event = events[index];
      gaps.push({ eventId: item.eventId, state: !event ? "DECLARED_BUT_MISSING" : event.eventHash !== item.eventHash ||
        event.applicationBodyHash && event.applicationBodyHash !== item.bodyHash ? "DECLARED_BUT_REJECTED" : "DECLARED_BUT_PENDING" });
    }
  }

  await context.vault.assertMain();

  return { binding: record.value.binding, snapshotId: record.value.snapshotId, declared: record.value.count,
    missingPages: pages.flatMap((page, index) => page.value ? [] : [index]), gaps, declaredSetVerified: present,
    appliedPages: record.value.next, snapshotApplied: present && gaps.length === 0 && record.value.next === record.value.totalPages };
};

/** Frozen outgoing declaration; receiver progress is never imported from another device. */
export const loadHistoryInventory = async (channel: string, requestId: string, context: ReceiveContext): Promise<HistoryInventory[]> => {
  await context.vault.assertMain();
  const key = headerKey(channel, requestId), record = await read<HistoryHeader>(key, context);

  if (!record.value) throw new Error("HISTORY_SNAPSHOT_UNAVAILABLE");
  const { pages, present } = await readPages(key, record.value, context);

  if (!present) throw new Error("HISTORY_SNAPSHOT_UNAVAILABLE");
  const { next: _next, ...declaration } = record.value;
  void _next;

  return pages.map((page, index) => ({ ...declaration, page: index, items: page.value! }));
};

/** Find prior incoming coverage without loading all retained headers/pages or importing another device's progress. */
export const findHistoryInventory = async (channel: string, expected: Omit<HistoryBinding, "requestId">, context: ReceiveContext) => {
  const prefix = headerKey(channel, "");
  let after = prefix;
  let completed: { requestId: string; resumable: boolean } | undefined;

  for (;;) {
    await context.vault.assertMain();
    const row = await context.vault.db.meta.where("key").between(after, `${prefix}\uffff`, false, true)
      .filter(row => !row.key.slice(prefix.length).includes(":" )).first();

    if (!row) return completed;
    // Fixed-length request nonces keep page keys outside the next header's range.
    after = `${row.key}:\uffff`;
    const header = await decryptJsonRecord<HistoryHeader>(context.vault.key, row.key, "history-inventory", row.value);
    const binding = header.binding;

    if (binding.accountIdentity !== expected.accountIdentity || binding.requesterDeviceId !== expected.requesterDeviceId ||
        binding.sourceDeviceId !== expected.sourceDeviceId || binding.scope !== expected.scope ||
        await hash(binding.history) !== await hash(expected.history)) continue;

    const current = binding.sourceIdentityPub === expected.sourceIdentityPub && binding.sourceEpoch === expected.sourceEpoch;

    if (current && header.next < header.totalPages) return { requestId: binding.requestId, resumable: true };
    completed ??= { requestId: binding.requestId, resumable: false };
  }
};
