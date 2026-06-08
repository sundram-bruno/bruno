# BRU-3205 — Preserve User-Configured Request Values on OpenAPI Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the **Spec Updates** sync, reconcile request *structure* against the spec (add/remove fields) while preserving the user's *values* (body, params, headers, auth, `{{envVar}}` refs) for fields that still exist.

**Architecture:** All merge logic lives in one backend file, `packages/bruno-electron/src/ipc/openapi-sync.js`. We add pure, field-level merge helpers gated by a single `preserveValues` flag (default `true`), thread that flag through the apply handler and the diff-preview handler, and drop value-level auth comparison from drift detection. The frontend adds a "Preserve values" toggle (default ON) on the Spec Updates review toolbar that re-renders the preview and is passed to apply.

**Tech Stack:** Electron main process (CommonJS, Jest with `--experimental-vm-modules`), React + Redux frontend, `@usebruno/converters` (`openApiToBruno`), `parseRequest`/`stringifyRequestViaWorker`.

**Decisions reference:** `/Users/sundramgupta/jiratickets/bru-3205/decisions.md`

---

## Design rules (apply to every merge helper)

- **`preserveValues` default `true`** = this ticket's behavior. `false` (future toggle) = spec values overwrite user values.
- **Structure always follows the spec.** Keys in spec but not user → added (spec value). Keys in user but not spec → removed. Only **shared keys** are governed by the flag.
- **Discriminator rule:** any section with a mode/type field (`auth.mode`, `body.mode`) — when the discriminator *differs*, the section can't be preserved (different shape) → take spec. When it *matches* → field-level value preserve under the flag.
- **URL** always follows spec (Option A; not preserved).
- **Reset path (`fullReset: true`) is NOT changed** — it keeps calling the existing `mergeWithUserValues`. New sync logic uses new helpers. This avoids any Collection-Changes/reset regression.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/bruno-electron/src/ipc/openapi-sync.js` | sync engine: merge helpers, apply handler, preview handler, detection | Modify |
| `packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js` | unit tests for all merge/compare helpers | Create |
| `packages/bruno-app/src/components/OpenAPISyncTab/SyncReviewPage/index.js` | Spec Updates review UI: add Preserve toggle, thread flag to apply + preview rows | Modify |
| `packages/bruno-app/src/components/OpenAPISyncTab/hooks/useSyncFlow.js` | apply IPC call: forward `preserveValues` | Modify |
| `packages/bruno-app/src/components/OpenAPISyncTab/EndpointChangeSection/ExpandableEndpointRow.js` | per-endpoint preview: pass `preserveValues` to IPC, re-fetch on change | Modify |

---

## Task 1: Export merge internals for testing + create test harness

The helpers are currently module-private. Export them (additive — existing exports keep working) so unit tests can require them.

**Files:**
- Modify: `packages/bruno-electron/src/ipc/openapi-sync.js:1696-1698`
- Test: `packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js`

- [ ] **Step 1: Add the test file with a smoke test that requires the (not-yet-exported) internals**

Create `packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js`:

```javascript
const { describe, it, expect } = require('@jest/globals');
const openapiSync = require('../../src/ipc/openapi-sync');

describe('openapi-sync merge internals are exported', () => {
  it('exposes the merge/compare helpers', () => {
    expect(typeof openapiSync._test.maskJsonInterpolations).toBe('function');
    expect(typeof openapiSync._test.unmaskJsonInterpolations).toBe('function');
    expect(typeof openapiSync._test.mergeJsonValues).toBe('function');
    expect(typeof openapiSync._test.mergeJsonBody).toBe('function');
    expect(typeof openapiSync._test.mergeFieldListPreserving).toBe('function');
    expect(typeof openapiSync._test.mergeAuth).toBe('function');
    expect(typeof openapiSync._test.mergeBody).toBe('function');
    expect(typeof openapiSync._test.mergeSpecIntoRequest).toBe('function');
    expect(typeof openapiSync._test.compareRequestFields).toBe('function');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "exposes the merge"`
Expected: FAIL — `Cannot read properties of undefined (reading 'maskJsonInterpolations')`.

- [ ] **Step 3: Add the `_test` export block**

In `packages/bruno-electron/src/ipc/openapi-sync.js`, after line 1698 (`module.exports.cleanupSpecFilesForCollection = ...`), append. The functions referenced are defined in later tasks; the block must list all of them now so later tasks don't touch exports again:

```javascript
// Internal helpers exported for unit testing only.
module.exports._test = {
  maskJsonInterpolations,
  unmaskJsonInterpolations,
  mergeJsonValues,
  mergeJsonBody,
  mergeFieldListPreserving,
  mergeAuth,
  mergeBody,
  mergeSpecIntoRequest,
  compareRequestFields
};
```

- [ ] **Step 4: Run — still fails (functions undefined) but for the right reason**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "exposes the merge"`
Expected: FAIL — `ReferenceError: mergeJsonValues is not defined` (the new helpers don't exist yet). This confirms the export block is wired; the helpers arrive in Tasks 2-6. Leave the test failing until then.

- [ ] **Step 5: Commit**

```bash
git add packages/bruno-electron/src/ipc/openapi-sync.js packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js
git commit -m "test(openapi-sync): scaffold merge-helper test harness and exports"
```

---

## Task 2: `maskJsonInterpolations` / `unmaskJsonInterpolations`

Bruno JSON bodies hold `{{var}}` interpolations that are invalid JSON. Mask them to parseable sentinels before parsing, restore after. Tracks in-string vs value position so bare-value vars get quoted while in-string vars stay bare.

**Files:**
- Modify: `packages/bruno-electron/src/ipc/openapi-sync.js` (add helpers above `mergeWithUserValues`, ~line 440)
- Test: `packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js`

- [ ] **Step 1: Write failing tests**

Append to the spec file:

```javascript
const { maskJsonInterpolations, unmaskJsonInterpolations } = openapiSync._test;

describe('maskJsonInterpolations', () => {
  it('quotes a bare-value variable so the result parses as JSON', () => {
    const { masked, vars } = maskJsonInterpolations('{"id": {{userId}}}');
    expect(() => JSON.parse(masked)).not.toThrow();
    expect(vars).toEqual(['{{userId}}']);
  });

  it('leaves an in-string variable unquoted (still inside the string)', () => {
    const { masked } = maskJsonInterpolations('{"auth": "Bearer {{token}}"}');
    const parsed = JSON.parse(masked);
    expect(parsed.auth.startsWith('Bearer ')).toBe(true);
  });

  it('round-trips bare and in-string vars unchanged through stringify', () => {
    const src = '{"id": {{userId}}, "auth": "Bearer {{token}}"}';
    const { masked, vars } = maskJsonInterpolations(src);
    const restored = unmaskJsonInterpolations(JSON.stringify(JSON.parse(masked)), vars);
    expect(restored).toContain('{{userId}}');
    expect(restored).toContain('Bearer {{token}}');
    // bare var must be unquoted after restore
    expect(restored).toMatch(/"id":\s*{{userId}}/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "maskJsonInterpolations"`
Expected: FAIL — `maskJsonInterpolations is not a function`.

- [ ] **Step 3: Implement the helpers**

In `openapi-sync.js`, immediately before `const mergeWithUserValues = ...` (line 441), insert:

```javascript
/**
 * Replace {{...}} interpolations with sentinel tokens so a Bruno JSON body
 * parses as valid JSON. Tracks whether we're inside a JSON string literal:
 *   - value position (outside a string): emit a *quoted* sentinel  -> valid value
 *   - inside a string: emit a *bare* sentinel                      -> stays in string
 * Returns { masked, vars } where vars[i] is the original {{...}} token.
 */
const maskJsonInterpolations = (str) => {
  const vars = [];
  let out = '';
  let inString = false;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '"' && str[i - 1] !== '\\') {
      inString = !inString;
      out += ch;
      i++;
      continue;
    }
    if (ch === '{' && str[i + 1] === '{') {
      const end = str.indexOf('}}', i + 2);
      if (end !== -1) {
        const token = str.slice(i, end + 2); // {{...}}
        const idx = vars.length;
        vars.push(token);
        out += inString ? `__BRUNO_VAR_${idx}__` : `"__BRUNO_VAR_${idx}__"`;
        i = end + 2;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return { masked: out, vars };
};

/**
 * Restore sentinel tokens produced by maskJsonInterpolations back to {{...}}.
 * Strips the surrounding quotes for value-position sentinels so {{var}} is
 * emitted unquoted (matching how the user wrote it).
 */
const unmaskJsonInterpolations = (str, vars) => {
  return str.replace(/"?__BRUNO_VAR_(\d+)__"?/g, (m, n) => {
    const original = vars[Number(n)];
    return original !== undefined ? original : m;
  });
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "maskJsonInterpolations"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/bruno-electron/src/ipc/openapi-sync.js packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js
git commit -m "feat(openapi-sync): add JSON interpolation mask/unmask helpers"
```

---

## Task 3: `mergeJsonValues` — deep key-path merge

Recursively reconcile a parsed JSON value: spec defines the key set; user supplies the values for shared keys. `preserveValues=false` returns the spec value wholesale.

**Files:**
- Modify: `packages/bruno-electron/src/ipc/openapi-sync.js` (after the mask helpers)
- Test: same spec file

- [ ] **Step 1: Write failing tests**

```javascript
const { mergeJsonValues } = openapiSync._test;

describe('mergeJsonValues', () => {
  it('keeps the user value for a shared key', () => {
    expect(mergeJsonValues({ id: 10 }, { id: 0 }, true)).toEqual({ id: 10 });
  });

  it('adds a key the spec introduces', () => {
    expect(mergeJsonValues({ id: 10 }, { id: 0, name: '' }, true)).toEqual({ id: 10, name: '' });
  });

  it('removes a key the spec dropped', () => {
    expect(mergeJsonValues({ id: 10, old: 'x' }, { id: 0 }, true)).toEqual({ id: 10 });
  });

  it('merges nested objects by path', () => {
    const user = { addr: { city: 'NYC', zip: '1' } };
    const spec = { addr: { city: '', country: '' } };
    expect(mergeJsonValues(user, spec, true)).toEqual({ addr: { city: 'NYC', country: '' } });
  });

  it('reconciles array element shape against the spec template, keeping user values', () => {
    const user = { items: [{ id: 1, gone: true }, { id: 2, gone: true }] };
    const spec = { items: [{ id: 0, qty: 0 }] };
    expect(mergeJsonValues(user, spec, true)).toEqual({ items: [{ id: 1, qty: 0 }, { id: 2, qty: 0 }] });
  });

  it('uses spec template when the user array is empty', () => {
    expect(mergeJsonValues({ items: [] }, { items: [{ id: 0 }] }, true)).toEqual({ items: [{ id: 0 }] });
  });

  it('takes spec values wholesale when preserveValues is false', () => {
    expect(mergeJsonValues({ id: 10 }, { id: 0, name: '' }, false)).toEqual({ id: 0, name: '' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "mergeJsonValues"`
Expected: FAIL — `mergeJsonValues is not a function`.

- [ ] **Step 3: Implement**

Insert after `unmaskJsonInterpolations`:

```javascript
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Reconcile a parsed JSON value: the spec defines the key set/shape; the user
 * supplies values for shared keys. Arrays use spec[0] as the element template.
 * preserveValues=false returns the spec value unchanged.
 */
const mergeJsonValues = (userVal, specVal, preserveValues = true) => {
  if (!preserveValues) return specVal;

  if (isPlainObject(specVal) && isPlainObject(userVal)) {
    const out = {};
    for (const key of Object.keys(specVal)) {
      out[key] = key in userVal
        ? mergeJsonValues(userVal[key], specVal[key], preserveValues)
        : specVal[key];
    }
    return out;
  }

  if (Array.isArray(specVal) && Array.isArray(userVal)) {
    if (userVal.length === 0) return specVal;
    const template = specVal.length > 0 ? specVal[0] : undefined;
    if (template === undefined) return userVal;
    return userVal.map((el) => mergeJsonValues(el, template, preserveValues));
  }

  // primitive, or shape mismatch -> keep the user's value (preserves {{var}} & real data)
  return userVal === undefined ? specVal : userVal;
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "mergeJsonValues"`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/bruno-electron/src/ipc/openapi-sync.js packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js
git commit -m "feat(openapi-sync): add deep key-path JSON value merge"
```

---

## Task 4: `mergeJsonBody` — wire mask + merge + fallback

Combine masking and `mergeJsonValues` to merge two JSON body objects (`{ mode:'json', json:'<string>' }`). If either side won't parse even after masking, fall back: preserve the user's body verbatim (or take spec when `preserveValues=false`).

**Files:**
- Modify: `packages/bruno-electron/src/ipc/openapi-sync.js`
- Test: same spec file

- [ ] **Step 1: Write failing tests**

```javascript
const { mergeJsonBody } = openapiSync._test;

describe('mergeJsonBody', () => {
  it('preserves user field values, adds new spec fields, drops removed', () => {
    const user = { mode: 'json', json: '{"id":10,"old":"x"}' };
    const spec = { mode: 'json', json: '{"id":0,"name":""}' };
    const merged = mergeJsonBody(user, spec, true);
    expect(JSON.parse(merged.json)).toEqual({ id: 10, name: '' });
  });

  it('preserves {{envVar}} references verbatim in the body', () => {
    const user = { mode: 'json', json: '{"id": {{userId}}, "tok": "Bearer {{t}}"}' };
    const spec = { mode: 'json', json: '{"id": 0, "tok": "", "extra": 1}' };
    const merged = mergeJsonBody(user, spec, true);
    expect(merged.json).toContain('{{userId}}');
    expect(merged.json).toContain('Bearer {{t}}');
    expect(merged.json).toContain('extra');
  });

  it('falls back to the user body verbatim when JSON is unparseable', () => {
    const user = { mode: 'json', json: '{ not valid json' };
    const spec = { mode: 'json', json: '{"id":0}' };
    expect(mergeJsonBody(user, spec, true).json).toBe('{ not valid json');
  });

  it('takes spec body when preserveValues is false', () => {
    const user = { mode: 'json', json: '{"id":10}' };
    const spec = { mode: 'json', json: '{"id":0}' };
    expect(mergeJsonBody(user, spec, false)).toEqual(spec);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "mergeJsonBody"`
Expected: FAIL — `mergeJsonBody is not a function`.

- [ ] **Step 3: Make the masker accept a prefix (avoid sentinel collisions)**

User-side and spec-added fields both carry sentinels in the merged value. If both used `__BRUNO_VAR_0__`, restore would collide. Give the masker a prefix param so user and spec use disjoint namespaces. Edit the two helpers from Task 2:

```javascript
const maskJsonInterpolations = (str, prefix = 'BRUNO_VAR') => {
  const vars = [];
  let out = '';
  let inString = false;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '"' && str[i - 1] !== '\\') {
      inString = !inString;
      out += ch;
      i++;
      continue;
    }
    if (ch === '{' && str[i + 1] === '{') {
      const end = str.indexOf('}}', i + 2);
      if (end !== -1) {
        const token = str.slice(i, end + 2);
        const idx = vars.length;
        vars.push(token);
        out += inString ? `__${prefix}_${idx}__` : `"__${prefix}_${idx}__"`;
        i = end + 2;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return { masked: out, vars };
};

const unmaskJsonInterpolations = (str, vars, prefix = 'BRUNO_VAR') => {
  const re = new RegExp(`"?__${prefix}_(\\d+)__"?`, 'g');
  return str.replace(re, (m, n) => (vars[Number(n)] !== undefined ? vars[Number(n)] : m));
};
```

The default prefix is unchanged, so Task 2's tests still pass.

- [ ] **Step 3b: Implement `mergeJsonBody` using disjoint prefixes**

Insert after `mergeJsonValues`:

```javascript
/**
 * Merge two JSON request bodies ({ mode:'json', json:'<string>' }) at the
 * field level, preserving user values and {{var}} refs. User and spec sides
 * are masked with disjoint prefixes so their sentinels never collide. Falls
 * back to the user's verbatim body if either side is unparseable.
 */
const mergeJsonBody = (userBody, specBody, preserveValues = true) => {
  if (!preserveValues) return specBody;
  if (!userBody?.json || !specBody?.json) return specBody;
  try {
    const u = maskJsonInterpolations(userBody.json, 'BRU_U');
    const s = maskJsonInterpolations(specBody.json, 'BRU_S');
    const merged = mergeJsonValues(JSON.parse(u.masked), JSON.parse(s.masked), preserveValues);
    let json = JSON.stringify(merged, null, 2);
    json = unmaskJsonInterpolations(json, u.vars, 'BRU_U');
    json = unmaskJsonInterpolations(json, s.vars, 'BRU_S');
    return { ...specBody, mode: 'json', json };
  } catch (e) {
    return { ...userBody };
  }
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "mergeJsonBody"`
Expected: PASS (4 tests). Also re-run Task 2: `-t "maskJsonInterpolations"` → still PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bruno-electron/src/ipc/openapi-sync.js packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js
git commit -m "feat(openapi-sync): field-level JSON body merge with var preservation"
```

---

## Task 5: `mergeFieldListPreserving` — params / headers / form fields

Name-keyed merge for arrays of `{ name, value, enabled, ... }`. Spec defines which entries exist; user supplies `value`+`enabled` for matched entries. Duplicate names are paired positionally (Decision B).

**Files:**
- Modify: `packages/bruno-electron/src/ipc/openapi-sync.js`
- Test: same spec file

- [ ] **Step 1: Write failing tests**

```javascript
const { mergeFieldListPreserving } = openapiSync._test;

describe('mergeFieldListPreserving', () => {
  it('keeps the user value+enabled for a matching name', () => {
    const spec = [{ name: 'q', value: '', enabled: true }];
    const user = [{ name: 'q', value: 'hello', enabled: false }];
    expect(mergeFieldListPreserving(spec, user, true)).toEqual([{ name: 'q', value: 'hello', enabled: false }]);
  });

  it('adds spec entries the user does not have', () => {
    const spec = [{ name: 'q', value: '' }, { name: 'page', value: '1' }];
    const user = [{ name: 'q', value: 'hi' }];
    const out = mergeFieldListPreserving(spec, user, true);
    expect(out.map((p) => p.name)).toEqual(['q', 'page']);
    expect(out[1].value).toBe('1');
  });

  it('drops user entries no longer in the spec', () => {
    const spec = [{ name: 'q', value: '' }];
    const user = [{ name: 'q', value: 'hi' }, { name: 'gone', value: 'x' }];
    expect(mergeFieldListPreserving(spec, user, true).map((p) => p.name)).toEqual(['q']);
  });

  it('pairs duplicate names positionally', () => {
    const spec = [{ name: 'X', value: '' }, { name: 'X', value: '' }];
    const user = [{ name: 'X', value: 'a' }, { name: 'X', value: 'b' }];
    expect(mergeFieldListPreserving(spec, user, true).map((p) => p.value)).toEqual(['a', 'b']);
  });

  it('preserves a multipart file value (array) by name', () => {
    const spec = [{ name: 'f', type: 'file', value: [] }];
    const user = [{ name: 'f', type: 'file', value: ['/tmp/a.png'], enabled: true }];
    expect(mergeFieldListPreserving(spec, user, true)[0].value).toEqual(['/tmp/a.png']);
  });

  it('returns spec entries unchanged when preserveValues is false', () => {
    const spec = [{ name: 'q', value: '' }];
    const user = [{ name: 'q', value: 'hi' }];
    expect(mergeFieldListPreserving(spec, user, false)).toEqual(spec);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "mergeFieldListPreserving"`
Expected: FAIL — `mergeFieldListPreserving is not a function`.

- [ ] **Step 3: Implement**

Insert after `mergeJsonBody`:

```javascript
/**
 * Merge a spec-defined list of {name,value,enabled,...} entries with the user's
 * entries. Spec defines membership (add new, drop removed). For matched names
 * the user's `value` and `enabled` win. Duplicate names pair positionally.
 */
const mergeFieldListPreserving = (specItems, existingItems, preserveValues = true) => {
  const spec = specItems || [];
  if (!preserveValues) return spec;
  const existing = existingItems || [];
  const cursorByName = {};
  return spec.map((specEntry) => {
    const matches = existing.filter((e) => e.name === specEntry.name);
    const cursor = cursorByName[specEntry.name] || 0;
    const picked = matches[cursor];
    if (!picked) return specEntry;
    cursorByName[specEntry.name] = cursor + 1;
    return { ...specEntry, value: picked.value, enabled: picked.enabled };
  });
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "mergeFieldListPreserving"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/bruno-electron/src/ipc/openapi-sync.js packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js
git commit -m "feat(openapi-sync): name-keyed param/header/form field merge"
```

---

## Task 6: `mergeAuth` and `mergeBody` dispatchers

`mergeAuth`: same `auth.mode` → keep the user's sub-object for that mode; different mode → spec wins. `mergeBody`: same `body.mode` → dispatch to JSON/form/raw merge; different mode → spec wins.

**Files:**
- Modify: `packages/bruno-electron/src/ipc/openapi-sync.js`
- Test: same spec file

- [ ] **Step 1: Write failing tests**

```javascript
const { mergeAuth, mergeBody } = openapiSync._test;

describe('mergeAuth', () => {
  it('preserves user auth field values when the mode matches', () => {
    const user = { mode: 'oauth2', oauth2: { accessTokenUrl: '{{url}}', scope: 'read' } };
    const spec = { mode: 'oauth2', oauth2: { accessTokenUrl: 'https://x', scope: '' } };
    expect(mergeAuth(user, spec, true)).toEqual({ mode: 'oauth2', oauth2: { accessTokenUrl: '{{url}}', scope: 'read' } });
  });

  it('takes spec auth when the mode differs', () => {
    const user = { mode: 'apikey', apikey: { key: 'X' } };
    const spec = { mode: 'oauth2', oauth2: { scope: 'read' } };
    expect(mergeAuth(user, spec, true)).toEqual(spec);
  });

  it('takes spec auth for none/inherit modes', () => {
    expect(mergeAuth({ mode: 'inherit' }, { mode: 'inherit' }, true)).toEqual({ mode: 'inherit' });
  });

  it('takes spec auth when preserveValues is false', () => {
    const user = { mode: 'oauth2', oauth2: { scope: 'read' } };
    const spec = { mode: 'oauth2', oauth2: { scope: '' } };
    expect(mergeAuth(user, spec, false)).toEqual(spec);
  });
});

describe('mergeBody', () => {
  it('dispatches json bodies to field-level merge', () => {
    const user = { mode: 'json', json: '{"id":10}' };
    const spec = { mode: 'json', json: '{"id":0,"name":""}' };
    expect(JSON.parse(mergeBody(user, spec, true).json)).toEqual({ id: 10, name: '' });
  });

  it('merges formUrlEncoded by name', () => {
    const user = { mode: 'formUrlEncoded', formUrlEncoded: [{ name: 'a', value: 'mine' }] };
    const spec = { mode: 'formUrlEncoded', formUrlEncoded: [{ name: 'a', value: '' }, { name: 'b', value: '' }] };
    const out = mergeBody(user, spec, true);
    expect(out.formUrlEncoded.find((f) => f.name === 'a').value).toBe('mine');
    expect(out.formUrlEncoded.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('keeps the user raw body verbatim for matching text/xml modes', () => {
    const user = { mode: 'xml', xml: '<a>{{v}}</a>' };
    const spec = { mode: 'xml', xml: '<a></a>' };
    expect(mergeBody(user, spec, true)).toEqual(user);
  });

  it('takes spec body when the body mode differs', () => {
    const user = { mode: 'json', json: '{"id":10}' };
    const spec = { mode: 'formUrlEncoded', formUrlEncoded: [] };
    expect(mergeBody(user, spec, true)).toEqual(spec);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "mergeAuth|mergeBody"`
Expected: FAIL — `mergeAuth is not a function`.

- [ ] **Step 3: Implement**

Insert after `mergeFieldListPreserving`:

```javascript
/**
 * Merge auth: same mode -> keep the user's sub-object for that mode (all nested
 * field values, incl. {{var}} refs). Different mode -> spec wins (mode change is
 * surfaced as a modification by detection). none/inherit have no fields to keep.
 */
const mergeAuth = (userAuth, specAuth, preserveValues = true) => {
  if (!preserveValues) return specAuth;
  const userMode = userAuth?.mode || 'none';
  const specMode = specAuth?.mode || 'none';
  if (userMode !== specMode) return specAuth;
  if (specMode === 'none' || specMode === 'inherit') return specAuth;
  const userSub = userAuth?.[specMode];
  if (userSub === undefined) return specAuth;
  return { ...specAuth, mode: specMode, [specMode]: userSub };
};

/**
 * Merge a request body: same mode -> field-level merge per mode; different mode
 * -> spec wins. Raw text modes keep the user's body verbatim.
 */
const mergeBody = (userBody, specBody, preserveValues = true) => {
  if (!preserveValues || !userBody || !specBody) return specBody;
  const specMode = specBody.mode || 'none';
  const userMode = userBody.mode || 'none';
  if (specMode !== userMode) return specBody;
  if (specMode === 'json') return mergeJsonBody(userBody, specBody, preserveValues);
  if (specMode === 'formUrlEncoded') {
    return { ...specBody, formUrlEncoded: mergeFieldListPreserving(specBody.formUrlEncoded, userBody.formUrlEncoded, preserveValues) || [] };
  }
  if (specMode === 'multipartForm') {
    return { ...specBody, multipartForm: mergeFieldListPreserving(specBody.multipartForm, userBody.multipartForm, preserveValues) || [] };
  }
  // raw modes: xml / text / sparql / graphql -> keep the user's body
  return { ...userBody };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "mergeAuth|mergeBody"`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/bruno-electron/src/ipc/openapi-sync.js packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js
git commit -m "feat(openapi-sync): add auth and body merge dispatchers"
```

---

## Task 7: Rewrite `mergeSpecIntoRequest` sync branch to preserve values

The sync branch (`fullReset: false`) currently overwrites `body`/`auth` wholesale. Replace with the new merge helpers, threaded by `preserveValues`. The `fullReset: true` branch is left untouched (reset/Collection-Changes path) — it keeps using the existing `mergeWithUserValues`.

**Files:**
- Modify: `packages/bruno-electron/src/ipc/openapi-sync.js:457-488`
- Test: same spec file

- [ ] **Step 1: Write failing tests**

```javascript
const { mergeSpecIntoRequest } = openapiSync._test;

describe('mergeSpecIntoRequest (sync mode, preserveValues default true)', () => {
  const existing = {
    name: 'r', type: 'http-request',
    request: {
      method: 'post', url: '{{old}}/x',
      params: [{ name: 'q', value: 'mine', enabled: true }],
      headers: [{ name: 'H', value: 'mine', enabled: true }],
      body: { mode: 'json', json: '{"id":10}' },
      auth: { mode: 'oauth2', oauth2: { scope: 'read' } },
      script: { req: 'console.log(1)' }, tests: 'expect(1)', assertions: [{ k: 'a' }]
    }
  };
  const specItem = {
    name: 'r', type: 'http-request',
    request: {
      method: 'post', url: '{{spec}}/x',
      params: [{ name: 'q', value: '', enabled: true }, { name: 'p', value: '', enabled: true }],
      headers: [{ name: 'H', value: '', enabled: true }],
      body: { mode: 'json', json: '{"id":0,"name":""}' },
      auth: { mode: 'oauth2', oauth2: { scope: '' } }
    }
  };

  it('takes the spec URL (Option A)', () => {
    expect(mergeSpecIntoRequest(existing, specItem).request.url).toBe('{{spec}}/x');
  });

  it('preserves user body values and adds new spec fields', () => {
    const out = mergeSpecIntoRequest(existing, specItem).request.body;
    expect(JSON.parse(out.json)).toEqual({ id: 10, name: '' });
  });

  it('preserves user param value and adds the new spec param', () => {
    const params = mergeSpecIntoRequest(existing, specItem).request.params;
    expect(params.find((p) => p.name === 'q').value).toBe('mine');
    expect(params.map((p) => p.name)).toEqual(['q', 'p']);
  });

  it('preserves user auth values when the mode matches', () => {
    expect(mergeSpecIntoRequest(existing, specItem).request.auth.oauth2.scope).toBe('read');
  });

  it('preserves scripts/tests/assertions', () => {
    const r = mergeSpecIntoRequest(existing, specItem).request;
    expect(r.script).toEqual({ req: 'console.log(1)' });
    expect(r.tests).toBe('expect(1)');
    expect(r.assertions).toEqual([{ k: 'a' }]);
  });

  it('overwrites values from spec when preserveValues is false', () => {
    const out = mergeSpecIntoRequest(existing, specItem, { preserveValues: false }).request;
    expect(JSON.parse(out.body.json)).toEqual({ id: 0, name: '' });
    expect(out.params.find((p) => p.name === 'q').value).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "mergeSpecIntoRequest"`
Expected: FAIL — body/auth come back as raw spec (`{ id: 0 }`), param `q` value is `''`.

- [ ] **Step 3: Rewrite the sync branch**

Replace lines 457-488 (the whole `mergeSpecIntoRequest` function). Keep the `fullReset` branch exactly as-is; rewrite only the sync return:

```javascript
const mergeSpecIntoRequest = (existingRequest, specItem, { fullReset = false, preserveValues = true } = {}) => {
  const mergedParams = mergeWithUserValues(specItem.request.params, existingRequest.request?.params);
  const mergedHeaders = mergeWithUserValues(specItem.request.headers, existingRequest.request?.headers);

  if (fullReset) {
    return {
      ...existingRequest,
      request: {
        ...existingRequest.request,
        url: specItem.request.url,
        method: specItem.request.method,
        body: specItem.request.body,
        auth: specItem.request.auth,
        docs: specItem.request.docs,
        params: mergedParams || [],
        headers: mergedHeaders || []
      }
    };
  }

  // Sync mode: reconcile structure to the spec while preserving the user's values.
  return {
    ...existingRequest,
    request: {
      ...existingRequest.request,
      url: specItem.request.url, // Option A: URL always follows the spec
      body: mergeBody(existingRequest.request?.body, specItem.request.body, preserveValues),
      auth: mergeAuth(existingRequest.request?.auth, specItem.request.auth, preserveValues),
      params: mergeFieldListPreserving(specItem.request.params, existingRequest.request?.params, preserveValues) || [],
      headers: mergeFieldListPreserving(specItem.request.headers, existingRequest.request?.headers, preserveValues) || []
    }
  };
};
```

Note: the `fullReset` branch still references `mergedParams`/`mergedHeaders` from the old `mergeWithUserValues` — unchanged, so reset behavior is byte-identical. The sync branch no longer uses those two locals; that's fine (they're only computed for the reset path now). To avoid computing them needlessly in sync mode, move the two `const merged*` lines inside the `if (fullReset)` block.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "mergeSpecIntoRequest"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/bruno-electron/src/ipc/openapi-sync.js packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js
git commit -m "feat(openapi-sync): preserve user values in sync-mode request merge"
```

---

## Task 8: Drop `authConfigDiff` from `compareRequestFields`

Once auth *values* are preserved, comparing them flags the collection permanently out of sync. Compare only `authMode`.

**Files:**
- Modify: `packages/bruno-electron/src/ipc/openapi-sync.js:585-606, 641, 659`
- Test: same spec file

- [ ] **Step 1: Write failing tests**

```javascript
const { compareRequestFields } = openapiSync._test;

describe('compareRequestFields auth comparison', () => {
  const base = { params: [], headers: [], body: { mode: 'none' } };

  it('does NOT flag a diff when only auth config values differ (same mode)', () => {
    const spec = { ...base, auth: { mode: 'oauth2', oauth2: { accessTokenUrl: 'https://x', scope: '' } } };
    const actual = { ...base, auth: { mode: 'oauth2', oauth2: { accessTokenUrl: '{{url}}', scope: 'read' } } };
    expect(compareRequestFields(spec, actual).hasDiff).toBe(false);
  });

  it('flags a diff when the auth mode differs', () => {
    const spec = { ...base, auth: { mode: 'oauth2', oauth2: {} } };
    const actual = { ...base, auth: { mode: 'apikey', apikey: {} } };
    const result = compareRequestFields(spec, actual);
    expect(result.hasDiff).toBe(true);
    expect(result.changes.join(',')).toContain('auth');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "compareRequestFields auth"`
Expected: FAIL — the first test reports `hasDiff: true` because `authConfigDiff` still fires.

- [ ] **Step 3: Remove the auth-config comparison**

In `compareRequestFields`:
1. Delete the entire `// Check auth config differences when auth modes match` block (lines ~585-606): the `let authConfigDiff = false;` declaration through its closing brace.
2. In the `hasDiff` expression (line ~641) remove `|| authConfigDiff`:
   ```javascript
   const hasDiff = paramsDiff || headersDiff || bodyDiff || authDiff || formFieldsDiff || jsonBodyDiff;
   ```
3. In the `changes` block (line ~659) delete:
   ```javascript
   if (authConfigDiff) changes.push('auth config');
   ```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/bruno-electron && npx jest tests/ipc/openapi-sync-merge.spec.js -t "compareRequestFields auth"`
Expected: PASS (2 tests). Run the whole file too: `npx jest tests/ipc/openapi-sync-merge.spec.js` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bruno-electron/src/ipc/openapi-sync.js packages/bruno-electron/tests/ipc/openapi-sync-merge.spec.js
git commit -m "fix(openapi-sync): compare auth by mode only so preserved values don't drift"
```

---

## Task 9: Thread `preserveValues` through the apply handler

`renderer:apply-openapi-sync` must accept `preserveValues` (default `true`) and pass it to the sync-mode merges (added-with-existing-file and modified branches). Reset / drift-reset paths keep `fullReset: true` untouched.

**Files:**
- Modify: `packages/bruno-electron/src/ipc/openapi-sync.js:1160, 1364, 1401`

- [ ] **Step 1: Add the param to the handler signature**

At line 1160, add `preserveValues = true` to the destructured payload:

```javascript
ipcMain.handle('renderer:apply-openapi-sync', async (event, { collectionPath, addNewRequests, removeDeletedRequests, diff, localOnlyToRemove = [], driftedToReset = [], mode = 'sync', endpointDecisions = {}, preserveValues = true }) => {
```

- [ ] **Step 2: Pass the flag to the added-endpoint merge (existing file case)**

At line ~1364 change:

```javascript
const mergedRequest = mergeSpecIntoRequest(existingFile.request, newItem, { preserveValues });
```

- [ ] **Step 3: Pass the flag to the modified-endpoint merge**

At line ~1401 change:

```javascript
const mergedRequest = mergeSpecIntoRequest(existingFile.request, newItem, { preserveValues });
```

- [ ] **Step 4: Manual verification (no automated IPC test in this suite)**

Run the existing backend suite to ensure nothing broke:
Run: `cd packages/bruno-electron && npm test`
Expected: existing suites PASS; the new `openapi-sync-merge.spec.js` PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bruno-electron/src/ipc/openapi-sync.js
git commit -m "feat(openapi-sync): forward preserveValues through apply handler"
```

---

## Task 10: Preview shows post-merge result (`get-endpoint-diff-data`)

The `newData` (EXPECTED column) must show the merged result, not raw spec, so unchanged user values don't render as changes. Accept `preserveValues` (default `true`).

**Files:**
- Modify: `packages/bruno-electron/src/ipc/openapi-sync.js:1065, 1099-1152`

- [ ] **Step 1: Add the param to the handler signature**

At line 1065:

```javascript
ipcMain.handle('renderer:get-endpoint-diff-data', async (event, { collectionPath, endpointId, newSpec, preserveValues = true }) => {
```

- [ ] **Step 2: Build merged newData when an existing request is present**

After `const actualRequest = actualFile?.request || null;` (line ~1103) and after `specItem` is resolved, compute the item to feed into `newData`. Replace the final `return { ... newData: transformToVisualFormat(specItem) }` (lines ~1147-1152) with:

```javascript
      // EXPECTED column = what sync will actually produce. For an endpoint that
      // already exists in the collection, that's the merged result (user values +
      // structural changes), not the raw spec. New endpoints (no actualRequest)
      // have nothing to preserve, so show the spec as-is.
      let specItemForDisplay = specItem;
      if (specItem && actualRequest) {
        const merged = mergeSpecIntoRequest({ request: actualRequest }, specItem, { preserveValues });
        specItemForDisplay = { ...specItem, request: merged.request };
      }

      return {
        error: null,
        oldData: transformToVisualFormat(actualRequest),
        newData: transformToVisualFormat(specItemForDisplay)
      };
```

- [ ] **Step 3: Manual verification**

Run: `cd packages/bruno-electron && npm test`
Expected: all suites PASS (this change has no new unit test; it is covered by the merge unit tests + manual UI check in Task 13).

- [ ] **Step 4: Commit**

```bash
git add packages/bruno-electron/src/ipc/openapi-sync.js
git commit -m "feat(openapi-sync): preview EXPECTED column shows post-merge result"
```

---

## Task 11: Frontend — forward `preserveValues` from the sync flow to apply

**Files:**
- Modify: `packages/bruno-app/src/components/OpenAPISyncTab/hooks/useSyncFlow.js:17, 65-75`

- [ ] **Step 1: Accept `preserveValues` in `performSync` and forward it**

Change the `performSync` signature (line 17) to accept it (default `true`):

```javascript
  const performSync = async (selections = { localOnlyIds: [], endpointDecisions: {} }, mode = 'sync', preserveValues = true) => {
```

Add it to the IPC payload (inside the `ipcRenderer.invoke('renderer:apply-openapi-sync', { ... })` object, after `endpointDecisions: decisions`):

```javascript
        endpointDecisions: decisions,
        preserveValues
```

- [ ] **Step 2: Forward it from `handleApplySync`**

Change `handleApplySync` (line ~102) to pull `preserveValues` from the selections object:

```javascript
  const handleApplySync = (selections) => {
    const mode = pendingSyncMode || 'sync';
    setPendingSyncMode(null);
    performSync(selections, mode, selections?.preserveValues ?? true);
  };
```

- [ ] **Step 3: Verify the app builds**

Run: `cd packages/bruno-app && npx eslint src/components/OpenAPISyncTab/hooks/useSyncFlow.js`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/bruno-app/src/components/OpenAPISyncTab/hooks/useSyncFlow.js
git commit -m "feat(openapi-sync-ui): forward preserveValues to apply IPC"
```

---

## Task 12: Frontend — add the Preserve toggle to the review toolbar

A two-state "Preserve values" toggle (default ON) next to "View Spec Diff", with an info tooltip. Its state is local (ephemeral, resets ON per open). Passed into `onApplySync` via the selections object.

**Files:**
- Modify: `packages/bruno-app/src/components/OpenAPISyncTab/SyncReviewPage/index.js:91-93, 206-214, 239-272`

- [ ] **Step 1: Add local toggle state**

Near the other `useState` calls (line ~91), add:

```javascript
  const [preserveValues, setPreserveValues] = useState(true);
```

- [ ] **Step 2: Include `preserveValues` in the apply payload**

In `handleConfirmApply` (line ~206), add it to the `onApplySync({...})` object:

```javascript
    onApplySync({
      endpointDecisions: decisions,
      localOnlyIds,
      preserveValues,
      newToCollection: filteredAddedEndpoints,
      specUpdates: filteredSpecChanges,
      resolvedConflicts: specUpdatedEndpoints.filter((ep) => ep.conflict && decisions[ep.id] === 'accept-incoming'),
      localChangesToReset: localUpdatedEndpoints.filter((ep) => decisions[ep.id] === 'accept-incoming')
    });
```

- [ ] **Step 3: Render the toggle in the toolbar**

In the `bulk-actions` div, add the toggle as the first child (before the `View Spec Diff` button, line ~241). `IconInfoCircle` is already imported:

```jsx
                <button
                  className={`bulk-btn ${preserveValues ? 'active' : ''}`}
                  onClick={() => setPreserveValues((v) => !v)}
                  title="When on, your edited values (body, params, headers, auth, {{vars}}) are kept; only fields the spec adds or removes change. When off, spec values overwrite yours."
                >
                  <IconCheck size={12} /> Preserve values
                  <IconInfoCircle size={12} style={{ marginLeft: 4, opacity: 0.7 }} />
                </button>
```

- [ ] **Step 4: Verify lint/build**

Run: `cd packages/bruno-app && npx eslint src/components/OpenAPISyncTab/SyncReviewPage/index.js`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/bruno-app/src/components/OpenAPISyncTab/SyncReviewPage/index.js
git commit -m "feat(openapi-sync-ui): add Preserve values toggle to Spec Updates review"
```

---

## Task 13: Frontend — preview re-fetches on toggle and uses `preserveValues`

The per-endpoint preview must pass `preserveValues` to `get-endpoint-diff-data` and re-fetch when the toggle flips (the cached `diffData` must be invalidated).

**Files:**
- Modify: `packages/bruno-app/src/components/OpenAPISyncTab/SyncReviewPage/index.js:322-328, 346-352, 370-376`
- Modify: `packages/bruno-app/src/components/OpenAPISyncTab/EndpointChangeSection/ExpandableEndpointRow.js:18, 28-52, 54-59`

- [ ] **Step 1: Pass `preserveValues` to each `ExpandableEndpointRow`**

In `SyncReviewPage/index.js`, every `<ExpandableEndpointRow ... />` instance that renders preview rows (the three at lines ~322, ~346, ~370 that already pass `collectionPath`/`newSpec`) gets one more prop:

```jsx
                      collectionPath={collectionPath}
                      newSpec={newSpec}
                      preserveValues={preserveValues}
```

- [ ] **Step 2: Accept the prop and send it in the IPC call**

In `ExpandableEndpointRow.js`, add `preserveValues = true` to the destructured props (line 18):

```javascript
const ExpandableEndpointRow = ({ endpoint, decision, onDecisionChange, collectionPath, newSpec, showDecisions = true, decisionLabels, diffLeftLabel, diffRightLabel, swapDiffSides, collectionUid, actions, preserveValues = true }) => {
```

In `loadDiffData` (line ~36), include it in the invoke payload and add it to the `useCallback` deps (line ~52):

```javascript
      const result = await ipcRenderer.invoke('renderer:get-endpoint-diff-data', {
        collectionPath,
        endpointId: endpoint.id,
        newSpec,
        preserveValues
      });
```

```javascript
  }, [collectionPath, endpoint.id, newSpec, preserveValues]);
```

- [ ] **Step 3: Invalidate cached diff when `preserveValues` changes**

`loadDiffData` early-returns if `diffData` is already set (line 29), so a toggle wouldn't re-fetch. Add an effect that clears the cache when the flag flips. After the existing "load when expanded" effect (line ~59), add:

```javascript
  // Re-fetch the preview when the preserve toggle changes — the EXPECTED column
  // depends on it. Clearing diffData lets the load effect run again.
  const didMountPreserve = React.useRef(false);
  useEffect(() => {
    if (!didMountPreserve.current) {
      didMountPreserve.current = true;
      return;
    }
    setDiffData(null);
    setError(null);
  }, [preserveValues]);
```

(`React` is already imported as the default in this file.)

- [ ] **Step 4: Verify lint/build**

Run: `cd packages/bruno-app && npx eslint src/components/OpenAPISyncTab/EndpointChangeSection/ExpandableEndpointRow.js src/components/OpenAPISyncTab/SyncReviewPage/index.js`
Expected: no errors.

- [ ] **Step 5: Manual smoke test (real app)**

Run the app, open a collection with an OpenAPI source, edit a request body value + a header, then open **Spec Updates**:
1. With **Preserve values ON** (default), expand a modified endpoint → EXPECTED column shows your edited values, only added/removed fields highlighted.
2. Toggle **OFF** → preview re-renders showing spec values.
3. Toggle back ON → Sync Collection → confirm the saved `.bru`/`.yml` keeps your values, `{{vars}}`, and gains the new spec fields; scripts/tests/assertions intact.
4. Re-open Spec Updates → the endpoint is no longer flagged out of sync.

- [ ] **Step 6: Commit**

```bash
git add packages/bruno-app/src/components/OpenAPISyncTab/SyncReviewPage/index.js packages/bruno-app/src/components/OpenAPISyncTab/EndpointChangeSection/ExpandableEndpointRow.js
git commit -m "feat(openapi-sync-ui): preview reflects Preserve toggle and re-fetches on change"
```

---

## Task 14: Full regression run

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend suite**

Run: `cd packages/bruno-electron && npm test`
Expected: all PASS, including `tests/ipc/openapi-sync-merge.spec.js`.

- [ ] **Step 2: Lint the touched frontend files**

Run: `cd packages/bruno-app && npx eslint src/components/OpenAPISyncTab/`
Expected: no errors.

- [ ] **Step 3: Final manual reset-path regression check**

In the app, use **Collection Changes → Reset** on a drifted endpoint and confirm it still replaces the request from spec while keeping scripts/tests/assertions (reset path is unchanged by this work, but verify once).

- [ ] **Step 4: Commit (if any lint fixups were needed)**

```bash
git add -A
git commit -m "chore(openapi-sync): regression pass for preserve-values sync"
```

---

## Acceptance Criteria → Task mapping (self-review)

| AC | Task(s) |
|---|---|
| Sync preserves user JSON body values for fields still in spec; only added/removed change | 3, 4, 7 |
| `{{envVar}}` survives in bodies, params, headers | 2, 4, 5, 7 |
| Param/header value + enabled preserved for entries still present | 5, 7 |
| Same `authMode` → all other auth values preserved, never overwritten (incl `{{var}}`) | 6, 7 |
| `authMode` differs → auth fields change to new mode, surfaced as modification | 6 (merge), 8 (detection keeps `authDiff`) |
| Auth config/credential diffs alone (same mode) not detected as drift | 8 |
| Pre/post scripts, tests, assertions preserved in sync and reset | 7 (sync via spread), 14 (reset verify) |
| Fields preserved by sync do not mark collection out of sync | 8 |
| Spec Updates diff preview shows post-sync result, not raw spec | 10, 13 |
| (Design seam) future "overwrite values" toggle | flag `preserveValues` everywhere; UI 12 |

**Out of scope (not in plan):** auth-mode preservation (separate ticket), per-field accept/reject, `syncProtect` configurable list, URL preservation.
