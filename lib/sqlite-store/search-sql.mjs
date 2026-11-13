// Search SQL helpers for SQLite store (task 394). Pure moves; no behavior changes.
import {
  ASSET_SEARCH_WEIGHTS,
  normalizeAssetSearchQuery,
} from "../asset-search.mjs";
import {
  conversationalAssetSearchPlan,
  designVocabularySearchPlan,
  finalizeConversationalSearchPlan,
} from "../asset-search-query-plan.mjs";
import { canonicalSourceTypeOf } from "../generation-session.mjs";
import {
  searchableAssetName,
  searchableBusinessFieldValues,
  searchableSourceValues,
} from "../asset-search-scope.mjs";

/**
 * Exported for tests (task 347): the exact helper bundle the store hands the
 * one-time search-scope rebuild, so a test can drive the whole-table
 * rebuildSearchScopeTexts against the same implementations the deferred
 * batched driver uses.
 */
export function searchScopeRebuildHelpers(database, { rowToAsset, syncAssetFtsEntry, replaceAssetShortTerms } = {}) {
  return {
    loadMetadata: (row) => rowToAsset(database, row),
    searchableText,
    syncAssetFtsEntry: (projectId, assetId, searchText, deletedAt) => syncAssetFtsEntry(database, projectId, assetId, searchText, deletedAt),
    replaceAssetShortTerms: (projectId, assetId, oldSearchText, newSearchText, deletedAt) => replaceAssetShortTerms(database, projectId, assetId, oldSearchText, newSearchText, deletedAt),
  };
}

export function searchableText(metadata) {
  return [
    // Task 375: the user's own wording (user_prompt) and the negative prompt
    // join the searchable text. Both live on the normalized metadata (and in
    // metadata_json, which rowToAsset spreads), so creation, updates and the
    // one-time search-scope rebuild below all see them.
    searchableAssetName(metadata.id), searchableAssetName(metadata.asset), metadata.prompt, metadata.user_prompt, metadata.negative_prompt, metadata.skill, metadata.style, metadata.theme, metadata.group, metadata.category,
    metadata.curation_note, ...(metadata.tags || []),
    ...searchableSourceValues(metadata.source, canonicalSourceTypeOf(metadata)),
    ...searchableBusinessFieldValues(metadata.business_fields),
  ].map((value) => typeof value === "string" || typeof value === "number" ? String(value) : "").join(" ");
}

export function buildSearchScoreSql(terms, params, alias = "a") {
  const lower = (column) => `lower(COALESCE(${column}, ''))`;
  const column = (name) => `${alias}.${name}`;
  const tagExact = (key) => `instr(char(31) || ${lower(column("tags_text"))} || char(31), char(31) || @${key} || char(31)) > 0`;
  const contains = (column, key) => `instr(${lower(column)}, @${key}) > 0`;
  // Contains terms on the id / file name run against the searchable name (the
  // machine-generated segments stripped); the exact comparisons below stay on
  // the raw columns.
  const containsSearchableName = (name, key) => `instr(lower(COALESCE(mosa_searchable_asset_name(${column(name)}), '')), @${key}) > 0`;
  const promptOccurrences = (key) => `(
    (length(${lower(column("prompt"))}) - length(replace(${lower(column("prompt"))}, @${key}, ''))) / length(@${key})
  )`;
  const promptScore = (key) => `(
    ${ASSET_SEARCH_WEIGHTS.promptContains}
    + min(${ASSET_SEARCH_WEIGHTS.promptFrequencyCap}, max(0, (${promptOccurrences(key)} - 1) * ${ASSET_SEARCH_WEIGHTS.promptFrequencyStep}))
    + CASE WHEN ltrim(${lower(column("prompt"))}) LIKE @${key} || '%' THEN ${ASSET_SEARCH_WEIGHTS.promptPrefixBonus} ELSE 0 END
  )`;
  const bestTermScore = (key) => `CASE
    WHEN ${lower(column("asset"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.assetExact}
    WHEN ${lower(column("id"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.idExact}
    WHEN ${tagExact(key)} THEN ${ASSET_SEARCH_WEIGHTS.tagExact}
    WHEN ${lower(column("category"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.categoryExact}
    WHEN ${lower(column("group_name"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.groupExact}
    WHEN ${containsSearchableName("asset", key)} THEN ${ASSET_SEARCH_WEIGHTS.assetContains}
    WHEN ${containsSearchableName("id", key)} THEN ${ASSET_SEARCH_WEIGHTS.idContains}
    WHEN ${contains(column("tags_text"), key)} THEN ${ASSET_SEARCH_WEIGHTS.tagContains}
    WHEN ${contains(column("category"), key)} THEN ${ASSET_SEARCH_WEIGHTS.categoryContains}
    WHEN ${contains(column("group_name"), key)} THEN ${ASSET_SEARCH_WEIGHTS.groupContains}
    WHEN ${lower(column("style"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.styleExact}
    WHEN ${lower(column("theme"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.themeExact}
    WHEN ${lower(column("skill"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.skillExact}
    WHEN ${contains(column("style"), key)} THEN ${ASSET_SEARCH_WEIGHTS.styleContains}
    WHEN ${contains(column("theme"), key)} THEN ${ASSET_SEARCH_WEIGHTS.themeContains}
    WHEN ${contains(column("skill"), key)} THEN ${ASSET_SEARCH_WEIGHTS.skillContains}
    WHEN ${lower(column("prompt"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.promptExact}
    WHEN ${contains(column("prompt"), key)} THEN ${promptScore(key)}
    WHEN ${contains(column("business_search_text"), key)} THEN ${ASSET_SEARCH_WEIGHTS.businessContains}
    WHEN ${contains(column("source_search_text"), key)} THEN ${ASSET_SEARCH_WEIGHTS.sourceContains}
    ELSE 0
  END`;
  const termScores = terms.map((term, index) => {
    const key = `searchTerm${index}`;
    params[key] = term;
    return bestTermScore(key);
  });
  // Candidate generation already applies AND semantics to every term against
  // search_text/FTS. search_text is assembled from the exact same fields scored
  // below, so re-evaluating every CASE once for "is non-zero" and again for its
  // value only doubles CPU without filtering any additional rows.
  const termScoreSum = termScores.map((score) => `(${score})`).join(" + ");

  const phrase = terms.join(" ");
  params.searchPhrase = phrase;
  const phraseBonus = `CASE
    WHEN instr(lower(COALESCE(mosa_searchable_asset_name(${column("asset")}), '')), @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseAssetBonus}
    WHEN instr(${lower(column("tags_text"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseTagBonus}
    WHEN instr(${lower(column("category"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseCategoryBonus}
    WHEN instr(${lower(column("group_name"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseGroupBonus}
    WHEN instr(${lower(column("prompt"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phrasePromptBonus}
    ELSE 0
  END`;
  return `((${termScoreSum}) + (${phraseBonus}))`;
}

export function escapeLikePattern(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function isIndexedShortUnicodeTerm(term) {
  const chars = [...String(term || "")];
  return chars.length > 0 && chars.length < 3 && chars.some((char) => char.codePointAt(0) > 0x7f);
}

// Exported for tests: the raw-database connections in test files register the
// mosa_short_search_terms_json SQL function with this same implementation, so
// fixtures that predate the doc-id migration can seed short terms the way the
// old code wrote them.
export function shortUnicodeSearchTerms(value) {
  const normalized = normalizeAssetSearchQuery(value);
  if (!normalized) return [];
  const result = new Set();
  for (const token of normalized.split(/\s+/u).filter(Boolean)) {
    const chars = [...token];
    for (let index = 0; index < chars.length; index += 1) {
      const single = chars[index];
      if (isIndexedShortUnicodeTerm(single)) result.add(single);
      if (index + 1 < chars.length) {
        const pair = `${chars[index]}${chars[index + 1]}`;
        if (isIndexedShortUnicodeTerm(pair)) result.add(pair);
      }
    }
  }
  return [...result];
}

// syncAssetFtsEntry / replaceAssetShortTerms / the rowid-delete helpers live
// with the task-348 doc-id block above (single authority for FTS + short-term
// writes; trash invariant: deleted_at set → delete only).

export function plainAsciiSearchTerms(query) {
  const value = String(query || "").trim();
  if ([...value].length < 3) return [];
  const terms = value.split(/\s+/).filter(Boolean);
  if (!terms.length || terms.some((term) => !/^[a-z0-9][a-z0-9._-]*$/i.test(term))) return [];
  return terms.map((term) => term.toLowerCase());
}

export function buildFtsQuery(query) {
  return String(query).trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

export function resolveAssetSearchQuery(database, projectId, query) {
  const normalized = normalizeAssetSearchQuery(query);
  const plan = conversationalAssetSearchPlan(normalized);
  let planned = normalized;
  if (plan) {
    const candidateTerms = plan.cjkTerms.filter(isIndexedShortUnicodeTerm);
    let knownTerms = new Set();
    if (candidateTerms.length) {
      // Task 348: the known-term check joins through the doc mapping. Trashed
      // assets carry no short-term rows since v18, so their words no longer
      // count as "known" here — an intentional change of this task.
      const rows = database.prepare(`
        SELECT DISTINCT st.term
        FROM asset_search_terms st
        JOIN asset_search_docs d ON d.doc_id = st.doc_id
        WHERE d.project_id = @projectId
          AND st.term IN (SELECT CAST(value AS TEXT) FROM json_each(@terms))
      `).all({ projectId, terms: JSON.stringify(candidateTerms) });
      knownTerms = new Set(rows.map((row) => String(row.term || "")));
    }
    planned = finalizeConversationalSearchPlan(plan, knownTerms)?.query || normalized;
  }
  return designVocabularySearchPlan(planned)?.query || planned;
}
