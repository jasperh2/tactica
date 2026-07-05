// core/persist.mjs — versioned serialize/deserialize envelope for DocState. [core-model]
// UI stores the result at localStorage["tactica:doc"], debounced 500ms (contract §4) — this
// module only handles the string <-> doc conversion, no localStorage access itself (pure,
// no node-only APIs, importable by the browser).
//
// SECURITY: deserialize() is the single choke point for two untrusted-input paths (app.mjs):
// the #pb= share-link hash and the localStorage boot doc. Both are attacker- or corruption-
// reachable — a hostile #pb= link is a same-origin XSS vector once the doc's strings reach the
// UI's attribute-interpolation sinks (canvas-objects.mjs, layers.mjs, playbookbar-helpers.mjs,
// drawtools-helpers.mjs). deserialize() therefore validates doc SHAPE, not just the envelope:
// every color is pattern-checked (bad -> safe fallback, never thrown away silently), every
// geometry number is Number()-coerced and required finite (bad -> the object is dropped, never
// propagated), unknown object kinds are dropped, and every object is rebuilt field-by-field from
// a per-kind whitelist so no smuggled extra key (__proto__ included) ever survives into the
// returned doc. Only shapes with NO recoverable structure (missing mapId/activeTacticId, non-
// array layers/tactics, zero layers survive sanitization) throw — callers (app.mjs) already
// catch both paths and fall back to a fresh doc, so throwing here is a safe, fail-closed exit,
// never a crash reaching the user.

/** Versioned schema identifier for the persisted envelope. */
export const SCHEMA = 'tactica-doc/v1';

/** Safe fallback color for any field that fails the hex-color pattern check. */
export const FALLBACK_COLOR = '#9aa3b2';

const HEX_COLOR_PATTERN = /^#[0-9a-f]{3,8}$/i;
const KNOWN_OBJECT_KINDS = new Set(['unit', 'route', 'zone', 'text', 'sketch']);

// Per-kind field whitelist (architecture contract §3-4). Anything not listed here is stripped
// on the way through deserialize — this is what kills a smuggled payload field (__proto__,
// onerror, or any other attacker-added key) even if it rides along on an otherwise-valid object.
const OBJECT_FIELD_KINDS = {
  // field -> coercion kind: 'string' | 'color' | 'number' (cosmetic scalar, non-finite -> 0) |
  // 'reqnumber' (required geometry scalar, non-finite -> NaN so the caller's allFinite check
  // drops the whole object rather than silently defaulting to a misleading 0) | 'boolean' |
  // 'kfnumber' (appearsAt/kf, clamps to 1 instead of dropping) | 'positions' | 'points' |
  // 'passthrough' (kept as-is; only used for small enum-like fields outside the injection surface).
  unit: {
    id: 'string',
    kind: 'passthrough',
    code: 'string',
    name: 'string',
    role: 'color',
    layerId: 'string',
    appearsAt: 'kfnumber',
    size: 'number',
    positions: 'positions',
  },
  route: {
    id: 'string',
    kind: 'passthrough',
    points: 'points',
    role: 'color',
    layerId: 'string',
    appearsAt: 'kfnumber',
    thickness: 'number',
    dashed: 'boolean',
    head: 'passthrough',
  },
  zone: {
    id: 'string',
    kind: 'passthrough',
    shape: 'passthrough',
    cx: 'reqnumber',
    cy: 'reqnumber',
    rx: 'reqnumber',
    ry: 'reqnumber',
    // 'points' reuses the existing route/sketch points coercion kind + sanitizePoints() helper
    // (shape:'polygon' zones only) rather than inventing a new coercion. Harmless when shape is
    // 'ellipse': obj.points is undefined, so sanitizePoints(undefined) below just returns null
    // and the polygon-only geometry check further down never runs for that object.
    points: 'points',
    role: 'color',
    layerId: 'string',
    appearsAt: 'kfnumber',
    fillOpacity: 'number',
    border: 'number',
    dashed: 'boolean',
    label: 'string-optional',
  },
  text: {
    id: 'string',
    kind: 'passthrough',
    x: 'reqnumber',
    y: 'reqnumber',
    text: 'string',
    size: 'number',
    chip: 'boolean',
    role: 'color',
    layerId: 'string',
    appearsAt: 'kfnumber',
  },
  sketch: {
    id: 'string',
    kind: 'passthrough',
    shape: 'passthrough',
    points: 'points',
    role: 'color',
    layerId: 'string',
    appearsAt: 'kfnumber',
    thickness: 'number',
    dashed: 'boolean',
    head: 'passthrough',
    fillOpacity: 'number',
    border: 'number',
  },
};

// Fields whose absence is fatal for the object (rather than a fallback/clamp) — geometry that
// can't be defaulted meaningfully. `positions`/`points` are checked structurally, not by key
// name, so they aren't listed here; see sanitizeObject's REQUIRES_GEOMETRY dispatch below.
const REQUIRES_NONEMPTY_POSITIONS = new Set(['unit']);

// Kinds whose 'points' field is UNCONDITIONALLY required (their only geometry) — route/sketch
// have no other way to render, so invalid/missing points always drops the object. Zone is
// deliberately NOT in this set: an ellipse zone (shape !== 'polygon') has no points field at
// all (undefined -> sanitizePoints returns null harmlessly), and only a shape:'polygon' zone
// requires points to be valid — that check lives in the zone-specific branch below instead,
// alongside the existing cx/cy/rx/ry-vs-points shape dispatch.
const REQUIRES_POINTS_UNCONDITIONALLY = new Set(['route', 'sketch']);

// Zone's ellipse-only geometry fields — applied ONLY when shape !== 'polygon'. A polygon zone
// must not carry these at all: obj.cx/cy/rx/ry are undefined on a polygon zone object, and
// running them through the ordinary 'reqnumber' coercion (Number(undefined) -> NaN) would leave
// stray cx:NaN/cy:NaN/... keys that serialize misleadingly as `null` via JSON.stringify. Kept as
// a small local set (not a new coercion kind) since this is the one field group whose
// APPLICABILITY, not just validity, depends on a sibling field's value (`shape`).
const ZONE_ELLIPSE_ONLY_FIELDS = new Set(['cx', 'cy', 'rx', 'ry']);

/**
 * Wraps `doc` in a versioned envelope and returns it as a JSON string.
 * @param {object} doc DocState per contract §3.
 * @returns {string}
 */
export function serialize(doc) {
  return JSON.stringify({ schema: SCHEMA, doc });
}

/**
 * Parses a serialized envelope, validates the enclosed doc's SHAPE (not just the envelope),
 * and returns a sanitized doc safe to hand to the UI's renderers. Throws a descriptive Error
 * on invalid JSON, a non-object payload, a missing/mismatched schema, or a doc shape with no
 * recoverable structure (see module docstring). Never returns unsanitized attacker-controlled
 * strings in color/geometry-adjacent fields.
 * @param {string} str
 * @returns {object}
 */
export function deserialize(str) {
  const payload = parseJson(str);
  assertPlainObject(payload, 'Persisted playbook payload must be a JSON object');

  if (typeof payload.schema !== 'string') {
    throw new Error(`Persisted playbook is missing a "schema" field (expected "${SCHEMA}")`);
  }
  if (payload.schema !== SCHEMA) {
    throw new Error(`Persisted playbook has schema "${payload.schema}", expected "${SCHEMA}"`);
  }
  assertPlainObject(payload.doc, 'Persisted playbook is missing a valid "doc" object');

  return sanitizeDoc(payload.doc);
}

function parseJson(str) {
  try {
    return JSON.parse(str);
  } catch (err) {
    throw new Error(`Persisted playbook is not valid JSON: ${err.message}`);
  }
}

function assertPlainObject(value, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// =============================================================================
// Doc-shape sanitization — fail-closed. Only genuinely irrecoverable shapes throw; everything
// else is coerced/dropped/defaulted so a hostile or corrupt doc never reaches the UI verbatim.
// =============================================================================

function sanitizeDoc(doc) {
  if (typeof doc.mapId !== 'string') {
    throw new Error('Persisted playbook doc is missing a valid "mapId" string');
  }
  if (typeof doc.activeTacticId !== 'string') {
    throw new Error('Persisted playbook doc is missing a valid "activeTacticId" string');
  }
  if (!Array.isArray(doc.layers)) {
    throw new Error('Persisted playbook doc has a non-array "layers" field');
  }
  if (!Array.isArray(doc.tactics)) {
    throw new Error('Persisted playbook doc has a non-array "tactics" field');
  }

  const layers = doc.layers.filter(isPlainObject).map(sanitizeLayer);
  if (layers.length === 0) {
    throw new Error('Persisted playbook doc has zero valid "layers" entries after sanitization');
  }

  const tactics = doc.tactics.filter(isPlainObject).map(sanitizeTactic);

  return { mapId: doc.mapId, layers, tactics, activeTacticId: doc.activeTacticId };
}

function sanitizeLayer(layer) {
  return {
    id: toStringField(layer.id),
    name: toStringField(layer.name),
    color: toSafeColor(layer.color),
    visible: Boolean(layer.visible),
    locked: Boolean(layer.locked),
  };
}

function sanitizeTactic(tactic) {
  const objects = Array.isArray(tactic.objects)
    ? tactic.objects.filter(isPlainObject).map(sanitizeObject).filter((obj) => obj !== null)
    : [];

  return {
    id: toStringField(tactic.id),
    name: toStringField(tactic.name),
    subtitle: toStringField(tactic.subtitle),
    nextId: toFiniteNumber(tactic.nextId, 1),
    keyframes: Array.isArray(tactic.keyframes)
      ? tactic.keyframes.filter(isPlainObject).map(sanitizeKeyframe)
      : [],
    objects,
    notes: sanitizeNotes(tactic.notes),
  };
}

function sanitizeKeyframe(kf) {
  return {
    n: toKeyframeNumber(kf.n),
    name: toStringField(kf.name),
    t: toStringField(kf.t),
  };
}

/**
 * Rebuilds a note record key-by-key via a numeric round-trip (Number(key) then back to a
 * plain string key), which is what actually defeats a JSON-smuggled `"__proto__"` key: numeric
 * coercion of the string "__proto__" yields NaN, so the guard below drops it before it is ever
 * used as a property name on the object literal being built.
 */
function sanitizeNotes(notes) {
  const result = {};
  if (!isPlainObject(notes)) return result;
  for (const [key, value] of Object.entries(notes)) {
    const n = Number(key);
    if (!Number.isFinite(n)) continue; // drops "__proto__" and any other non-numeric key
    result[String(n)] = toStringField(value);
  }
  return result;
}

/**
 * Rebuilds one MapObject field-by-field from the per-kind whitelist (OBJECT_FIELD_KINDS) —
 * this is what strips smuggled extra keys, since only whitelisted fields are ever read off
 * the untrusted input. Unknown kinds return null (caller filters them out). Objects whose
 * required geometry is missing/non-finite also return null (dropped, not thrown — a single bad
 * object should not brick the whole doc).
 * @param {object} obj
 * @returns {object|null}
 */
function sanitizeObject(obj) {
  const kind = typeof obj.kind === 'string' ? obj.kind : null;
  if (!kind || !KNOWN_OBJECT_KINDS.has(kind)) return null;

  const fields = OBJECT_FIELD_KINDS[kind];
  const result = {};

  for (const [field, coercion] of Object.entries(fields)) {
    if (coercion === 'positions') {
      const positions = sanitizePositions(obj.positions);
      if (positions === null && REQUIRES_NONEMPTY_POSITIONS.has(kind)) return null;
      result.positions = positions ?? {};
      continue;
    }
    if (coercion === 'points') {
      const points = sanitizePoints(obj.points);
      // route/sketch have no other geometry — invalid/missing points always drops them. Zone's
      // points requirement is shape-conditional (only shape:'polygon' needs it), checked in the
      // zone-specific branch below instead, so an ellipse zone's naturally-absent points field
      // (sanitizePoints(undefined) -> null) does NOT drop the object here — it instead leaves
      // `points` as `undefined` on the result (same "absent, not null" convention as the
      // `string-optional` coercion for `label`), so an ellipse zone's output stays byte-
      // identical to before this change: no stray `points` key of any kind.
      if (points === null && REQUIRES_POINTS_UNCONDITIONALLY.has(kind)) return null;
      if (points !== null) result.points = points;
      continue;
    }
    // A polygon zone has no ellipse geometry — skip cx/cy/rx/ry entirely rather than coercing
    // Number(undefined) into a stray NaN field (see ZONE_ELLIPSE_ONLY_FIELDS doc comment).
    if (kind === 'zone' && obj.shape === 'polygon' && ZONE_ELLIPSE_ONLY_FIELDS.has(field)) {
      continue;
    }
    result[field] = applyScalarCoercion(obj[field], coercion, field);
  }

  // Zone's required geometry is shape-conditional: shape:'polygon' needs a valid points array
  // (>=3 vertices — a polygon can't be rendered/hit-tested with fewer); every other shape
  // (including a zone with no shape field at all — backward compat with pre-shape-field zone
  // objects, see persist-hardening.test.mjs) keeps the original ellipse cx/cy/rx/ry
  // requirement UNCHANGED, so existing ellipse zones round-trip exactly as before this change.
  if (kind === 'zone') {
    if (result.shape === 'polygon') {
      if (result.points === undefined || result.points.length < 3) return null;
    } else if (!allFinite(result, ['cx', 'cy', 'rx', 'ry'])) {
      return null;
    }
  }
  // x/y (text) is required scalar geometry — a non-finite value there makes the object
  // unrenderable, same failure mode as positions/points, so drop rather than silently
  // defaulting to 0 (which would render a wrong, misleading shape instead of nothing).
  if (kind === 'text' && !allFinite(result, ['x', 'y'])) return null;

  return result;
}

function allFinite(obj, keys) {
  return keys.every((key) => Number.isFinite(obj[key]));
}

function applyScalarCoercion(value, coercion, field) {
  switch (coercion) {
    case 'string':
      return toStringField(value);
    case 'string-optional':
      return value === undefined ? undefined : toStringField(value);
    case 'color':
      return toSafeColor(value);
    case 'boolean':
      return Boolean(value);
    case 'kfnumber':
      return toKeyframeNumber(value);
    case 'number': {
      // Cosmetic numeric fields (size, thickness, fillOpacity, border) fall back to 0 on
      // non-finite input — a wrong-but-finite render beats dropping the whole object over them.
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case 'reqnumber': {
      // Required-geometry scalars (cx/cy/rx/ry/x/y): deliberately return NaN (not a fallback)
      // on non-finite input so allFinite() below catches it and the WHOLE OBJECT is dropped —
      // a made-up 0 here would silently render a wrong shape instead of nothing.
      return Number(value);
    }
    case 'passthrough':
      return value;
    default:
      throw new Error(`persist.mjs: unknown coercion kind "${coercion}" for field "${field}"`);
  }
}

/**
 * Sanitizes a marker's positions map ({kfNumber: {x,y}}). Returns null when the map is missing,
 * empty, or every entry is invalid — playbook.mjs's positionAt() has its own {x:50,y:50}
 * fallback for markers with no usable positions, but a marker with literally nothing to place
 * is dropped here rather than silently placed at a made-up default (matches the "malformed
 * beyond repair for THIS object -> drop the object" rule the other geometry fields follow).
 * @param {unknown} positions
 * @returns {Record<string,{x:number,y:number}>|null}
 */
function sanitizePositions(positions) {
  if (!isPlainObject(positions)) return null;
  const result = {};
  for (const [key, value] of Object.entries(positions)) {
    const kf = Number(key);
    if (!Number.isFinite(kf)) continue; // drops "__proto__" and other non-numeric keys
    if (!isPlainObject(value)) continue;
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    result[String(kf)] = { x, y };
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Sanitizes a points array ([[x,y], ...]) — routes/sketches need at least 2 finite pairs to be
 * a renderable line. Any single non-finite coordinate invalidates the whole array (a partially
 * numeric polyline is not a safe partial render, it's a corrupt one), returning null so the
 * caller drops the object.
 * @param {unknown} points
 * @returns {number[][]|null}
 */
function sanitizePoints(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const result = [];
  for (const pair of points) {
    if (!Array.isArray(pair) || pair.length < 2) return null;
    const x = Number(pair[0]);
    const y = Number(pair[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    result.push([x, y]);
  }
  return result;
}

/** Coerces any value to a string, per contract's "notes values coerced to String" instruction. */
function toStringField(value) {
  return String(value ?? '');
}

/** Pattern-validates a hex color; falls back to FALLBACK_COLOR rather than throwing. */
function toSafeColor(value) {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value) ? value : FALLBACK_COLOR;
}

/** Number()-coerces a plain numeric field with a fallback for non-finite results. */
function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Keyframe/appearsAt numbers clamp to 1 on non-finite input rather than dropping the object —
 * per the fix-set instruction ("clamp appearsAt/kf to 1"), since a bad frame number is
 * recoverable (show it at frame 1) in a way a bad coordinate is not.
 */
function toKeyframeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 1;
}
