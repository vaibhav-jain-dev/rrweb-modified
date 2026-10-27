import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/config/env.ts';
import type { SourceDef, ToolDef } from '../src/config/types.ts';
import {
  bindFilter,
  buildConnection,
  normalize,
  parseMongoSpec,
  scrub,
} from '../src/sources/mongo.ts';
import { ToolError } from '../src/sources/types.ts';

const tool = (
  spec: Record<string, unknown>,
  args: ToolDef['args'] = {},
): ToolDef => ({
  name: 't',
  description: '',
  source: 's',
  args,
  spec,
});

const HEX = '6a62d0b46ccb69068d608083';

describe('read-only guarantees', () => {
  it('refuses operators that run code or write', () => {
    for (const op of [
      '$where',
      '$function',
      '$accumulator',
      '$out',
      '$merge',
    ]) {
      expect(
        parseMongoSpec(tool({ collection: 'c', filter: { a: { [op]: 'x' } } })),
      ).toMatch(/forbidden operator/);
      expect(
        parseMongoSpec(
          tool({ collection: 'c', filter: { $or: [{ [op]: 1 }] } }),
        ),
      ).toMatch(/forbidden operator/);
    }
  });
  it('requires an explicit filter so a tool cannot scan by accident', () => {
    expect(parseMongoSpec(tool({ collection: 'c' }))).toMatch(
      /filter is required/,
    );
  });
  it('caps the row limit', () => {
    const spec = parseMongoSpec(
      tool({ collection: 'c', filter: {}, limit: 99999 }),
    );
    expect(typeof spec === 'object' && spec.limit).toBe(50);
  });
  it('rejects a weird collection name', () => {
    expect(parseMongoSpec(tool({ collection: 'a$b', filter: {} }))).toMatch(
      /collection/,
    );
  });
});

describe('typed argument binding', () => {
  const types = {
    id: 'id',
    oid: 'objectid',
    n: 'number',
    s: 'string',
    list: 'string[]',
  } as const;

  it('turns an id into a match on both ObjectId and string', () => {
    const out = bindFilter({ _id: '$id' }, { id: HEX }, types) as {
      _id: { $in: unknown[] };
    };
    expect(out._id.$in).toHaveLength(2);
    expect(out._id.$in[0]).toBeInstanceOf(ObjectId);
    expect(out._id.$in[1]).toBe(HEX);
  });
  it('keeps a non-hex id as a plain string', () => {
    expect(bindFilter({ _id: '$id' }, { id: 'abc' }, types)).toEqual({
      _id: 'abc',
    });
  });
  it('rejects a bad objectid instead of querying with it', () => {
    expect(() => bindFilter({ _id: '$oid' }, { oid: 'nope' }, types)).toThrow(
      ToolError,
    );
  });
  it('can never turn an argument into an operator', () => {
    const attack = '{"$ne": null}';
    expect(bindFilter({ title: '$s' }, { s: attack }, types)).toEqual({
      title: attack,
    });
    expect(() => bindFilter({ n: '$n' }, { n: { $gt: 0 } }, types)).toThrow(
      ToolError,
    );
  });
  it('refuses a filter that names an undeclared argument', () => {
    expect(() => bindFilter({ a: '$ghost' }, {}, types)).toThrow(/undeclared/);
  });
  it('binds inside nested $or lists', () => {
    const out = bindFilter(
      { $or: [{ a: '$s' }, { b: '$s' }] },
      { s: 'x' },
      types,
    );
    expect(out).toEqual({ $or: [{ a: 'x' }, { b: 'x' }] });
  });
});

describe('what leaves the provider', () => {
  it('turns ids and dates into strings', () => {
    const oid = new ObjectId(HEX);
    expect(
      normalize({ _id: oid, at: new Date('2026-01-02T03:04:05Z') }),
    ).toEqual({ _id: HEX, at: '2026-01-02T03:04:05.000Z' });
  });
  it('hides sensitive-looking keys even when projected', () => {
    const out = normalize({
      user: { ssn: '123-45-6789', password: 'x', api_key: 'k', name: 'ok' },
    }) as { user: Record<string, string> };
    expect(out.user).toEqual({
      ssn: '[REDACTED]',
      password: '[REDACTED]',
      api_key: '[REDACTED]',
      name: 'ok',
    });
  });
  it('bounds long strings and long arrays', () => {
    const out = normalize({
      s: 'x'.repeat(1000),
      a: Array.from({ length: 80 }, (_, i) => i),
    }) as { s: string; a: unknown[] };
    expect(out.s.length).toBeLessThan(310);
    expect(out.a).toHaveLength(51);
    expect(out.a[50]).toBe('[+30 more]');
  });
  it('scrubs connection strings out of driver errors', () => {
    expect(
      scrub(new Error('bad auth for mongodb://u:p@host:1/db failed')),
    ).not.toMatch(/u:p/);
  });
});

describe('connection settings', () => {
  const write = (name: string, text: string) => {
    const p = join(mkdtempSync(join(tmpdir(), 'agent-env-')), name);
    writeFileSync(p, text);
    return p;
  };
  const def = (
    file: string,
    extra: Record<string, unknown> = {},
  ): SourceDef => ({
    name: 'devlms',
    type: 'mongo',
    config: { envFile: file, ...extra },
  });

  it('reads the KEY: value form the real file uses, and the KEY=value form', () => {
    const colon = write(
      '.env.mongo',
      'MONGO_HOST: h.example\nMONGO_PORT: 27017\nMONGO_INITDB_ROOT_PASSWORD: "p$ss"\n',
    );
    const eq = write(
      '.env',
      "# c\nMONGO_HOST=h.example\nexport MONGO_PORT=27017\nMONGO_INITDB_ROOT_PASSWORD='p$ss'\n",
    );
    for (const f of [colon, eq]) {
      const env = readEnvFile(f);
      expect(env.MONGO_HOST).toBe('h.example');
      expect(env.MONGO_INITDB_ROOT_PASSWORD).toBe('p$ss');
    }
  });

  it('builds the URI without credentials and passes them as options', () => {
    const f = write(
      '.env.mongo',
      'MONGO_HOST: h.example\nMONGO_PORT: 27017\nMONGO_INITDB_DATABASE: devlms\nMONGO_INITDB_ROOT_USERNAME: u\nMONGO_INITDB_ROOT_PASSWORD: "p@ss$word"\n',
    );
    const c = buildConnection(def(f), {});
    expect(c.uri).toBe('mongodb://h.example:27017/');
    expect(c.uri).not.toMatch(/p@ss/);
    expect(c.options.auth).toEqual({ username: 'u', password: 'p@ss$word' });
    expect(c.database).toBe('devlms');
    expect(c.options.readPreference).toBe('secondaryPreferred');
  });

  it('lets AGENT_* variables reroute without touching the env file', () => {
    const f = write(
      '.env.mongo',
      'MONGO_HOST: remote\nMONGO_INITDB_DATABASE: devlms\n',
    );
    expect(
      buildConnection(def(f), {
        AGENT_MONGO_HOST_OVERRIDE: '127.0.0.1:27018',
        AGENT_MONGO_DIRECT: 'true',
      }),
    ).toMatchObject({
      uri: 'mongodb://127.0.0.1:27018/',
      options: { directConnection: true },
    });
    expect(
      buildConnection(def(f), {
        AGENT_MONGO_URI: 'mongodb://127.0.0.1:27017/devlms',
      }).uri,
    ).toBe('mongodb://127.0.0.1:27017/devlms');
    expect(
      buildConnection(def(f), {
        AGENT_MONGO_TLS: 'true',
        AGENT_MONGO_TLS_CA_FILE: '/x/ca.pem',
      }).options,
    ).toMatchObject({ tls: true, tlsCAFile: '/x/ca.pem' });
  });

  it('never opens the credentials file when a full URI is given', () => {
    const missing = join(tmpdir(), 'does-not-exist', '.env.mongo');
    const c = buildConnection(def(missing), {
      AGENT_MONGO_URI: 'mongodb://127.0.0.1:27017/localcopy',
    });
    expect(c.uri).toBe('mongodb://127.0.0.1:27017/localcopy');
    expect(c.database).toBe('localcopy');
    expect(
      buildConnection(def(missing), {
        AGENT_MONGO_URI: 'mongodb://h/',
        AGENT_MONGO_DATABASE: 'other',
      }).database,
    ).toBe('other');
    expect(() =>
      buildConnection(def(missing), { AGENT_MONGO_URI: 'mongodb://h/' }),
    ).toThrow(/no database name/);
  });

  it('says what is missing without printing the file', () => {
    const f = write('.env.mongo', 'MONGO_INITDB_DATABASE: devlms\n');
    expect(() => buildConnection(def(f), {})).toThrow(/no MONGO_HOST/);
  });
});
