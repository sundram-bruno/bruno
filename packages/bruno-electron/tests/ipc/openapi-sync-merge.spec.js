/**
 * Tests for openapi-sync merge helpers (Batch A: Tasks 1-4).
 * Run: cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js
 */
const { describe, it, expect, beforeAll } = require('@jest/globals');

process.env.NODE_ENV = 'test';

const syncModule = require('../../src/ipc/openapi-sync');
let helpers;

beforeAll(() => {
  helpers = syncModule._test;
});

// ---------------------------------------------------------------------------
// Task 1: Smoke — each exported helper is a function
// ---------------------------------------------------------------------------
describe('_test exports', () => {
  it('exports maskJsonInterpolations as a function', () => {
    expect(typeof helpers.maskJsonInterpolations).toBe('function');
  });

  it('exports unmaskJsonInterpolations as a function', () => {
    expect(typeof helpers.unmaskJsonInterpolations).toBe('function');
  });

  it('exports mergeJsonValues as a function', () => {
    expect(typeof helpers.mergeJsonValues).toBe('function');
  });

  it('exports mergeJsonBody as a function', () => {
    expect(typeof helpers.mergeJsonBody).toBe('function');
  });

  it('exports mergeSpecIntoRequest as a function', () => {
    expect(typeof helpers.mergeSpecIntoRequest).toBe('function');
  });

  it('exports compareRequestFields as a function', () => {
    expect(typeof helpers.compareRequestFields).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Task 2: maskJsonInterpolations / unmaskJsonInterpolations
// ---------------------------------------------------------------------------
describe('maskJsonInterpolations', () => {
  it('quotes a bare-value variable so result parses as JSON', () => {
    const { masked, vars } = helpers.maskJsonInterpolations('{"id": {{userId}}}');
    expect(() => JSON.parse(masked)).not.toThrow();
    expect(vars).toEqual(['{{userId}}']);
  });

  it('leaves an in-string variable unquoted (bearer prefix preserved)', () => {
    const { masked } = helpers.maskJsonInterpolations('{"auth": "Bearer {{token}}"}');
    const parsed = JSON.parse(masked);
    expect(parsed.auth).toMatch(/^Bearer /);
  });

  it('round-trips bare and in-string vars', () => {
    const src = '{"id": {{userId}}, "auth": "Bearer {{token}}"}';
    const { masked, vars } = helpers.maskJsonInterpolations(src);
    const roundTripped = helpers.unmaskJsonInterpolations(JSON.stringify(JSON.parse(masked)), vars);
    expect(roundTripped).toContain('{{userId}}');
    expect(roundTripped).toContain('Bearer {{token}}');
    expect(roundTripped).toMatch(/"id":\s*{{userId}}/);
  });

  it('handles a string value ending with a backslash (escaped quote disambiguation)', () => {
    const src = '{"path": "C:\\\\", "id": {{userId}}}';
    const { masked, vars } = helpers.maskJsonInterpolations(src);
    expect(() => JSON.parse(masked)).not.toThrow();
    expect(vars).toEqual(['{{userId}}']);
  });
});

// ---------------------------------------------------------------------------
// Task 3: mergeJsonValues
// ---------------------------------------------------------------------------
describe('mergeJsonValues', () => {
  it('keeps user value for shared key', () => {
    expect(helpers.mergeJsonValues({ id: 10 }, { id: 0 }, true)).toEqual({ id: 10 });
  });

  it('adds key spec introduces', () => {
    expect(helpers.mergeJsonValues({ id: 10 }, { id: 0, name: '' }, true)).toEqual({ id: 10, name: '' });
  });

  it('removes key spec dropped', () => {
    expect(helpers.mergeJsonValues({ id: 10, old: 'x' }, { id: 0 }, true)).toEqual({ id: 10 });
  });

  it('merges nested objects', () => {
    expect(
      helpers.mergeJsonValues({ addr: { city: 'NYC', zip: '1' } }, { addr: { city: '', country: '' } }, true)
    ).toEqual({ addr: { city: 'NYC', country: '' } });
  });

  it('array element shape vs template keeping user values', () => {
    expect(
      helpers.mergeJsonValues(
        { items: [{ id: 1, gone: true }, { id: 2, gone: true }] },
        { items: [{ id: 0, qty: 0 }] },
        true
      )
    ).toEqual({ items: [{ id: 1, qty: 0 }, { id: 2, qty: 0 }] });
  });

  it('empty user array uses spec template', () => {
    expect(helpers.mergeJsonValues({ items: [] }, { items: [{ id: 0 }] }, true)).toEqual({
      items: [{ id: 0 }]
    });
  });

  it('keeps a user array of primitives as-is against a single-element template', () => {
    expect(helpers.mergeJsonValues({ tags: [1, 2, 3] }, { tags: [0] }, true)).toEqual({ tags: [1, 2, 3] });
  });

  it('preserveValues=false takes spec', () => {
    expect(helpers.mergeJsonValues({ id: 10 }, { id: 0, name: '' }, false)).toEqual({ id: 0, name: '' });
  });
});

// ---------------------------------------------------------------------------
// Task 4: mergeJsonBody
// ---------------------------------------------------------------------------
describe('mergeJsonBody', () => {
  it('preserves user field values, adds new, drops removed', () => {
    const userBody = { mode: 'json', json: '{"id":10,"old":"x"}' };
    const specBody = { mode: 'json', json: '{"id":0,"name":""}' };
    const merged = helpers.mergeJsonBody(userBody, specBody, true);
    expect(JSON.parse(merged.json)).toEqual({ id: 10, name: '' });
  });

  it('preserves {{envVar}} references', () => {
    const userBody = { mode: 'json', json: '{"id": {{userId}}, "tok": "Bearer {{t}}"}' };
    const specBody = { mode: 'json', json: '{"id": 0, "tok": "", "extra": 1}' };
    const merged = helpers.mergeJsonBody(userBody, specBody, true);
    expect(merged.json).toContain('{{userId}}');
    expect(merged.json).toContain('Bearer {{t}}');
    expect(merged.json).toContain('extra');
  });

  it('unparseable user json falls back verbatim', () => {
    const userBody = { mode: 'json', json: '{ not valid json' };
    const specBody = { mode: 'json', json: '{"id":0}' };
    const merged = helpers.mergeJsonBody(userBody, specBody, true);
    expect(merged.json).toBe('{ not valid json');
  });

  it('preserveValues=false returns spec body', () => {
    const userBody = { mode: 'json', json: '{"id":10}' };
    const specBody = { mode: 'json', json: '{"id":0,"name":""}' };
    const merged = helpers.mergeJsonBody(userBody, specBody, false);
    expect(merged).toBe(specBody);
  });
});

// ---------------------------------------------------------------------------
// Task 5 smoke: _test exports new helpers
// ---------------------------------------------------------------------------
describe('_test exports (Batch B)', () => {
  it('exports mergeFieldListPreserving as a function', () => {
    expect(typeof helpers.mergeFieldListPreserving).toBe('function');
  });

  it('exports mergeAuth as a function', () => {
    expect(typeof helpers.mergeAuth).toBe('function');
  });

  it('exports mergeBody as a function', () => {
    expect(typeof helpers.mergeBody).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Task 5: mergeFieldListPreserving
// ---------------------------------------------------------------------------
describe('mergeFieldListPreserving', () => {
  it('keeps user value+enabled for matching name', () => {
    const spec = [{ name: 'q', value: '', enabled: true }];
    const user = [{ name: 'q', value: 'hello', enabled: false }];
    const out = helpers.mergeFieldListPreserving(spec, user);
    expect(out).toEqual([{ name: 'q', value: 'hello', enabled: false }]);
  });

  it('adds spec entries user lacks', () => {
    const spec = [{ name: 'q', value: '' }, { name: 'page', value: '1' }];
    const user = [{ name: 'q', value: 'hi' }];
    const out = helpers.mergeFieldListPreserving(spec, user);
    expect(out.map((e) => e.name)).toEqual(['q', 'page']);
    expect(out[1].value).toBe('1');
  });

  it('drops user entries not in spec', () => {
    const spec = [{ name: 'q', value: '' }];
    const user = [{ name: 'q', value: 'hi' }, { name: 'gone', value: 'x' }];
    const out = helpers.mergeFieldListPreserving(spec, user);
    expect(out.map((e) => e.name)).toEqual(['q']);
  });

  it('pairs duplicate names positionally', () => {
    const spec = [{ name: 'X', value: '' }, { name: 'X', value: '' }];
    const user = [{ name: 'X', value: 'a' }, { name: 'X', value: 'b' }];
    const out = helpers.mergeFieldListPreserving(spec, user);
    expect(out.map((e) => e.value)).toEqual(['a', 'b']);
  });

  it('preserves multipart file value (array) by name', () => {
    const spec = [{ name: 'f', type: 'file', value: [] }];
    const user = [{ name: 'f', type: 'file', value: ['/tmp/a.png'], enabled: true }];
    const out = helpers.mergeFieldListPreserving(spec, user);
    expect(out[0].value).toEqual(['/tmp/a.png']);
  });

  it('preserveValues=false returns spec entries unchanged', () => {
    const spec = [{ name: 'q', value: '' }];
    const user = [{ name: 'q', value: 'hi' }];
    const out = helpers.mergeFieldListPreserving(spec, user, false);
    expect(out).toEqual(spec);
  });
});
