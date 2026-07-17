/**
 * Skill-pack content, authored as exported TypeScript string constants so it
 * compiles straight into dist/ — there is no copy step and no runtime file read
 * of source markdown. `installSkillPack` (../install.ts) writes these strings to
 * the target skill directory / AGENTS.md.
 *
 * Split by target doc: ./skill.ts (SKILL.md), ./commands.ts (references/commands.md),
 * ./schemas.ts (references/schemas.md), ./taxonomy.ts (references/taxonomy.md),
 * ./codex.ts (AGENTS.md block + markers). Re-exported here so callers keep a
 * single import path.
 */
export { SKILL_MD } from "./skill.js";
export { COMMANDS_REFERENCE_MD } from "./commands.js";
export { SCHEMAS_MD } from "./schemas.js";
export { renderTaxonomyMd } from "./taxonomy.js";
export { CODEX_BEGIN_MARKER, CODEX_END_MARKER, CODEX_BLOCK_RE, AGENTS_MD_BLOCK } from "./codex.js";
