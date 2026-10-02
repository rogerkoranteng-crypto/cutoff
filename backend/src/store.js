// Storage. One interface, two backends: DynamoDB in production, a Map in tests and local preview.
// Items are { pk, sk, ...fields }. `put` accepts a condition on the stored `version` field.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

export class ConflictError extends Error { constructor(m = 'version conflict') { super(m); this.status = 409; } }

export class MemoryStore {
  constructor() { this.m = new Map(); }
  key(pk, sk) { return `${pk}\u0000${sk}`; }
  async get(pk, sk) { const v = this.m.get(this.key(pk, sk)); return v ? structuredClone(v) : null; }
  /** expectVersion: undefined = unconditional, null = must not exist, number = must equal */
  async put(item, { expectVersion, ifAbsent } = {}) {
    const cur = this.m.get(this.key(item.pk, item.sk));
    if (ifAbsent && cur) throw new ConflictError('already exists');
    if (expectVersion !== undefined && (expectVersion === null ? cur : (cur?.version !== expectVersion))) throw new ConflictError();
    this.m.set(this.key(item.pk, item.sk), structuredClone(item));
  }
  async patch(pk, sk, fields) {
    const cur = this.m.get(this.key(pk, sk));
    if (!cur) throw new Error('no such item');
    Object.assign(cur, structuredClone(fields));
  }
  async query(pk, prefix = '', { limit = 50, reverse = false } = {}) {
    const rows = [...this.m.values()].filter((v) => v.pk === pk && v.sk.startsWith(prefix)).sort((a, b) => (a.sk < b.sk ? -1 : 1));
    if (reverse) rows.reverse();
    return rows.slice(0, limit).map((r) => structuredClone(r));
  }
  async del(pk, sk) { this.m.delete(this.key(pk, sk)); }
}

export class DynamoStore {
  constructor(table = process.env.TABLE_NAME) {
    this.t = table;
    this.c = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } });
  }
  async get(pk, sk) { return (await this.c.send(new GetCommand({ TableName: this.t, Key: { pk, sk } }))).Item ?? null; }
  async put(item, { expectVersion, ifAbsent } = {}) {
    const p = { TableName: this.t, Item: item };
    if (ifAbsent || expectVersion === null) p.ConditionExpression = 'attribute_not_exists(pk)';
    else if (expectVersion !== undefined) { p.ConditionExpression = '#v = :v'; p.ExpressionAttributeNames = { '#v': 'version' }; p.ExpressionAttributeValues = { ':v': expectVersion }; }
    try { await this.c.send(new PutCommand(p)); }
    catch (e) { if (e.name === 'ConditionalCheckFailedException') throw new ConflictError(); throw e; }
  }
  async patch(pk, sk, fields) {
    const names = {}; const vals = {}; const sets = [];
    Object.entries(fields).forEach(([k, v], i) => { names[`#f${i}`] = k; vals[`:v${i}`] = v; sets.push(`#f${i} = :v${i}`); });
    await this.c.send(new UpdateCommand({ TableName: this.t, Key: { pk, sk }, UpdateExpression: 'SET ' + sets.join(', '), ExpressionAttributeNames: names, ExpressionAttributeValues: vals }));
  }
  async query(pk, prefix = '', { limit = 50, reverse = false } = {}) {
    const out = await this.c.send(new QueryCommand({
      TableName: this.t, KeyConditionExpression: prefix ? 'pk = :p AND begins_with(sk, :s)' : 'pk = :p',
      ExpressionAttributeValues: prefix ? { ':p': pk, ':s': prefix } : { ':p': pk }, Limit: limit, ScanIndexForward: !reverse,
    }));
    return out.Items ?? [];
  }
  async del(pk, sk) { await this.c.send(new DeleteCommand({ TableName: this.t, Key: { pk, sk } })); }
}
