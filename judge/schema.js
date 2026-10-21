'use strict';

const TAXONOMY_REF_KEY = '$taxonomy';

const isTaxonomyRef = (node) =>
  node !== null &&
  typeof node === 'object' &&
  !Array.isArray(node) &&
  typeof node[TAXONOMY_REF_KEY] === 'string';

const resolveNode = (node, taxonomy) => {
  if (isTaxonomyRef(node)) {
    const key = node[TAXONOMY_REF_KEY];
    const values = taxonomy[key];
    if (!Array.isArray(values)) {
      throw new Error(`unknown taxonomy key: ${key}`);
    }
    return { type: 'string', enum: [...values] };
  }
  if (Array.isArray(node)) {
    return node.map((item) => resolveNode(item, taxonomy));
  }
  if (node !== null && typeof node === 'object') {
    const resolved = {};
    for (const [prop, value] of Object.entries(node)) {
      resolved[prop] = resolveNode(value, taxonomy);
    }
    return resolved;
  }
  return node;
};

// Replaces every { "$taxonomy": "<key>" } in the template with the matching
// taxonomy entry's enum; the template and taxonomy are both treated
// as already-read data, never fetched here.
const buildSchema = (template, taxonomy) => resolveNode(template, taxonomy);

module.exports = { TAXONOMY_REF_KEY, buildSchema };
