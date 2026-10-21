'use strict';

// The "path to skills" table of the factory's own development session: skills that must be
// loaded before a JavaScript file of this repository is edited. Projects get their own table
// from the shared hook of the package; this file serves only this repository.
const BASE_SKILLS = ['js-conventions', 'js-gof', 'js-data-structures', 'error-handling', 'modern-javascript'];

const RULES = [{ extensions: /\.(js|mjs|cjs)$/, label: 'JavaScript', skills: BASE_SKILLS }];

module.exports = { BASE_SKILLS, RULES };
