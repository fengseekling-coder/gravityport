// Gallery pagination and collapsed stack-node cache for SQLite store (task 422). Pure moves; no behavior changes.
import { recentCutoffTimestamp } from "../recent-window.js";
import { assetOrganizedSql } from "../asset-organized.mjs";
import { assetSearchKind, normalizeAssetSearchQuery } from "../asset-search.mjs";
import { assetTimeFilterKey, encodeCursor } from "./cursors.mjs";
import { buildFtsQuery, buildSearchScoreSql, escapeLikePattern, isIndexedShortUnicodeTerm } from "./search-sql.mjs";
import { sanitizeId } from "./util.mjs";
import { attachAssetTags, rowToAsset } from "./asset-records.mjs";
import { annotateAssetStackCovers, annotateGalleryNodeSort } from "./stacks.mjs";

export const PAGE_ASSET_COLUMNS = [
  "project_id", "id", "asset", "original_path", "preview_path", "medium_path", "thumbnail_path",
  "prompt", "skill", "style", "ratio", "business_fields_json", "theme", "favorite", "archived",
  "group_name", "category", "rating", "parent_asset_id", "version_change", "deleted_at", "created_at", "updated_at",
  "source_json", "metadata_json", "sort_name", "palette_json",
  // content_sha256 feeds the ?v= content version on derivative URLs, so the
  // gallery page and the single-asset read hand out the same URL.
  "content_sha256",
].map((column) => `a.${column}`).join(", ");

export function appendFilterConditions(conditions, params, filters, alias = "a") {
  const column = (name) => `${alias}.${name}`;
  if (Number.isFinite(filters.createdAfterMs)) {
    conditions.push(`${column("created_at_epoch")} >= @createdAfterMs`);
    params.createdAfterMs = filters.createdAfterMs;
  }
  if (Number.isFinite(filters.createdBeforeMs)) {
    conditions.push(`${column("created_at_epoch")} <= @createdBeforeMs`);
    params.createdBeforeMs = filters.createdBeforeMs;
  }
  if (filters.source) {
    conditions.push(`${column("source_group")} = @source`);
    params.source = filters.source;
  }
  if (filters.group) {
    conditions.push(`${column("group_name")} = @group`);
    params.group = filters.group;
  }
  // Task 459: a learning-library view lists exactly that library's members
  // (trash-hidden upstream), without touching groups or stacks.
  if (filters.learningLibrary) {
    conditions.push(`EXISTS (
      SELECT 1 FROM learning_library_members m
      WHERE m.project_id = ${alias}.project_id AND m.library_id = @learningLibrary AND m.asset_id = ${alias}.id
    )`);
    params.learningLibrary = filters.learningLibrary;
  }
  if (filters.conversation) {
    conditions.push(`${column("conversation_id")} = @conversation`);
    params.conversation = filters.conversation;
  }
  if (filters.generationBatch) {
    conditions.push(`${column("generation_batch")} = @generationBatch`);
    params.generationBatch = filters.generationBatch;
  }
  if (filters.category) {
    conditions.push(`${column("category")} = @category`);
    params.category = filters.category;
  }
  if (filters.style) {
    conditions.push(`${column("style")} = @style`);
    params.style = filters.style;
  }
  if (filters.favorite) conditions.push(`(${column("rating")} > 0 OR ${column("favorite")} = 1)`);
  if (filters.unorganized) conditions.push(`NOT ${assetOrganizedSql(alias)}`);
  if (filters.mediaKind === "img") conditions.push(`${column("media_kind")} = 'image'`);
  if (filters.mediaKind === "video") conditions.push(`${column("media_kind")} = 'video'`);
  if (filters.recent) {
    conditions.push(`${column("created_at_epoch")} >= @recentSince`);
    params.recentSince = Number.isFinite(filters.recentSince) ? filters.recentSince : recentCutoffTimestamp();
  }
}

export function appendSearchConditions(conditions, params, query, { alias = "a", prefix = "search" } = {}) {
  const normalized = normalizeAssetSearchQuery(query);
  const terms = normalized.split(/\s+/u).filter(Boolean);
  if (!terms.length) return { terms, searchKind: "", scoreSql: "1" };
  const searchKind = assetSearchKind(normalized);
  // Whole-string exact match (see listAssetPage): one id/file-name-shaped term
  // OR-ed into the FTS and LIKE arms, so a pasted full id / file name still
  // finds the asset when its machine-generated segments stay out of the
  // indexes.
  const exactCondition = !searchKind && terms.length === 1
    && /^[a-z0-9][a-z0-9._-]*$/i.test(terms[0])
    ? `mosa_asset_exact_match(${alias}.id, ${alias}.asset, @${prefix}ExactTerm) = 1`
    : "";
  if (exactCondition) params[`${prefix}ExactTerm`] = normalized;
  const ftsTerms = terms.filter((term) => [...term].length >= 3);
  const shortTerms = terms.filter((term) => [...term].length < 3);
  const indexedShortTerms = shortTerms.filter(isIndexedShortUnicodeTerm);
  indexedShortTerms.forEach((term, index) => {
    const key = `${prefix}Short${index}`;
    params[key] = term;
    conditions.push(`${alias}.id IN (
      SELECT short_doc.asset_id FROM asset_search_terms short_term
      JOIN asset_search_docs short_doc ON short_doc.doc_id = short_term.doc_id
      WHERE short_doc.project_id = @projectId AND short_term.term = @${key}
    )`);
  });
  if (ftsTerms.length) {
    const key = `${prefix}FtsQuery`;
    params[key] = buildFtsQuery(ftsTerms.join(" "));
    const membership = `${alias}.id IN (SELECT asset_id FROM asset_fts WHERE project_id = @projectId AND content MATCH @${key})`;
    conditions.push(exactCondition ? `(${membership} OR ${exactCondition})` : membership);
  }
  const likeTerms = (ftsTerms.length ? shortTerms : terms).filter((term) => !indexedShortTerms.includes(term));
  likeTerms.forEach((term, index) => {
    const key = `${prefix}Like${index}`;
    // Task 348: LIKE over the FTS content table's narrow copy of the search
    // text instead of the wide assets rows; same LOWER() and escape semantics.
    const like = `${alias}.id IN (
      SELECT short_content.c1 FROM asset_fts_content short_content
      WHERE short_content.c0 = @projectId
        AND LOWER(short_content.c2) LIKE @${key} ESCAPE '\\'
    )`;
    conditions.push(exactCondition ? `(${like} OR ${exactCondition})` : like);
    params[key] = `%${escapeLikePattern(term)}%`;
  });
  if (searchKind) {
    const key = `${prefix}SearchKind`;
    params[key] = searchKind;
    conditions.push(`mosa_asset_matches_search_kind(
      @${key}, ${alias}.asset, ${alias}.id, ${alias}.prompt, ${alias}.skill, ${alias}.style, ${alias}.theme,
      ${alias}.group_name, ${alias}.category, ${alias}.tags_text
    ) = 1`);
  }
  return { terms, searchKind, scoreSql: searchKind ? buildSearchScoreSql(terms, params, alias) : "1" };
}

export function buildCollapsedMatchedCte({ filters, projectId, searchQuery }) {
  const params = { projectId };
  const memberConditions = ["m.project_id = @projectId", "m.archived = 0", "m.deleted_at IS NULL"];
  // Incremental reconciliation: evaluate every member of the nodes reachable
  // from the affected asset ids, so the node set is bounded by the affected
  // ids while `_matched_member_count` and `matched_first_position` evaluate
  // ALL matching members of each node (a direct id filter would corrupt both).
  // Affected STACK ids are reachable too: a cover swap (member archived,
  // trashed or moved out) changes the node's identity without any surviving
  // member being individually affected, so the client must receive the
  // stack's current node row to replace the stale cover card.
  const reachability = [];
  if (Array.isArray(filters.assetIds) && filters.assetIds.length) {
    params.reconcileAssetIds = JSON.stringify([...new Set(filters.assetIds.map((assetId) => sanitizeId(assetId, "asset")))]);
    reachability.push(`(
      m.id IN (SELECT CAST(value AS TEXT) FROM json_each(@reconcileAssetIds))
      OR sm.stack_id IN (
        SELECT sm2.stack_id FROM asset_stack_members sm2
        WHERE sm2.project_id = @projectId
          AND sm2.asset_id IN (SELECT CAST(value AS TEXT) FROM json_each(@reconcileAssetIds))
      )
    )`);
  }
  if (Array.isArray(filters.requestedStackIds) && filters.requestedStackIds.length) {
    params.reconcileStackIds = JSON.stringify([...new Set(filters.requestedStackIds.map((stackId) => sanitizeId(stackId, "stack")))]);
    reachability.push(`sm.stack_id IN (SELECT CAST(value AS TEXT) FROM json_each(@reconcileStackIds))`);
  }
  if (reachability.length) memberConditions.push(`(${reachability.join(" OR ")})`);
  appendFilterConditions(memberConditions, params, filters, "m");
  // Search normally evaluates member assets. A custom Stack name is a first-
  // class gallery label, though, so the collapsed root must also be discoverable
  // by that name even when no member metadata contains the query. Keep the
  // ordinary facets on members (source/group/favorite/etc.) and OR only the
  // textual search predicate with the Stack-name predicate so a name match
  // cannot bypass the active gallery filters.
  const memberSearchConditions = [];
  const search = appendSearchConditions(memberSearchConditions, params, searchQuery, { alias: "m", prefix: "node" });
  if (search.terms.length) {
    const stackNameConditions = search.terms.map((term, index) => {
      const key = `nodeStackNameLike${index}`;
      params[key] = `%${escapeLikePattern(term)}%`;
      return `LOWER(COALESCE(stack_meta.name, '')) LIKE @${key} ESCAPE '\\'`;
    });
    memberConditions.push(`((${memberSearchConditions.join(" AND ")}) OR (${stackNameConditions.join(" AND ")}))`);
  }

  // A filtered collapsed stack card displays the matching member with minimum
  // position (which equals the whole-stack cover when that cover also matches,
  // or when no user facet is active). Shared by listCollapsedAssetPage and
  // listGalleryRowsForAssets so both endpoints always resolve the same card.
  const matchedCte = `matched_groups AS MATERIALIZED (
    SELECT
      COALESCE(sm.stack_id, 'asset:' || m.id) AS node_key,
      sm.stack_id AS stack_id,
      MIN(m.id) AS single_asset_id,
      MIN(sm.position) AS matched_first_position,
      COUNT(*) AS _matched_member_count,
      MAX(${search.scoreSql}) AS _search_score
    FROM assets m
    LEFT JOIN asset_stack_members sm
      ON sm.project_id = m.project_id AND sm.asset_id = m.id
    LEFT JOIN asset_stacks stack_meta
      ON stack_meta.project_id = sm.project_id AND stack_meta.id = sm.stack_id
    WHERE ${memberConditions.join(" AND ")}
    GROUP BY node_key, sm.stack_id
  ), matched AS MATERIALIZED (
    SELECT
      mg.node_key,
      COALESCE(matched_cover.asset_id, mg.single_asset_id) AS node_asset_id,
      mg.stack_id,
      mg._matched_member_count,
      mg._search_score
    FROM matched_groups mg
    LEFT JOIN asset_stack_members matched_cover
      ON matched_cover.project_id = @projectId
      AND matched_cover.stack_id = mg.stack_id
      AND matched_cover.position = mg.matched_first_position
  )`;

  return { matchedCte, params, search };
}

export function listCollapsedAssetPage(database, { filters, projectId, limit, sort, searchQuery, cursor }) {
  const hasCollapsedFacet = Boolean(
    filters.source || filters.group || filters.conversation || filters.generationBatch
    || filters.category || filters.style || filters.favorite || filters.unorganized
    || filters.learningLibrary
    || filters.mediaKind || filters.recent || (Array.isArray(filters.assetIds) && filters.assetIds.length)
    || (Array.isArray(filters.requestedStackIds) && filters.requestedStackIds.length)
    || Number.isFinite(filters.createdAfterMs) || Number.isFinite(filters.createdBeforeMs),
  );
  if (!searchQuery && !hasCollapsedFacet) {
    return listCollapsedAssetPageFast(database, { filters, projectId, limit, sort, cursor });
  }
  const { matchedCte, params, search } = buildCollapsedMatchedCte({ filters, projectId, searchQuery });

  const rowsCte = `node_rows AS MATERIALIZED (
    SELECT ${PAGE_ASSET_COLUMNS}, matched._search_score, matched._matched_member_count,
      COALESCE(NULLIF(s.sort_created_at, ''), a.created_at) AS _node_created_at,
      COALESCE(NULLIF(s.sort_name, ''), a.sort_name) AS _node_sort_name
    FROM matched
    JOIN assets a ON a.project_id = @projectId AND a.id = matched.node_asset_id
    LEFT JOIN asset_stacks s ON s.project_id = @projectId AND s.id = matched.stack_id
  )`;

  const pageConditions = [];
  if (cursor) {
    params.cursorId = cursor.id;
    params.cursorCreatedAt = cursor.createdAt;
    params.cursorSortName = cursor.sortName;
    const secondary = sort === "name"
      ? "(r._node_sort_name > @cursorSortName OR (r._node_sort_name = @cursorSortName AND r.id > @cursorId))"
      : sort === "oldest"
        ? "(r._node_created_at > @cursorCreatedAt OR (r._node_created_at = @cursorCreatedAt AND r.id > @cursorId))"
        : "(r._node_created_at < @cursorCreatedAt OR (r._node_created_at = @cursorCreatedAt AND r.id < @cursorId))";
    if (search.searchKind) {
      params.cursorSearchScore = cursor.searchScore;
      pageConditions.push(`(r._search_score < @cursorSearchScore OR (r._search_score = @cursorSearchScore AND ${secondary}))`);
    } else {
      pageConditions.push(secondary);
    }
  }

  const orderBy = search.searchKind
    ? `r._search_score DESC, ${sort === "name"
      ? "r._node_sort_name ASC, r.id ASC"
      : sort === "oldest"
        ? "r._node_created_at ASC, r.id ASC"
        : "r._node_created_at DESC, r.id DESC"}`
    : sort === "name"
      ? "r._node_sort_name ASC, r.id ASC"
      : sort === "oldest"
        ? "r._node_created_at ASC, r.id ASC"
        : "r._node_created_at DESC, r.id DESC";
  const where = pageConditions.length ? `WHERE ${pageConditions.join(" AND ")}` : "";
  const sql = `WITH ${matchedCte}, ${rowsCte}
    SELECT r.* FROM node_rows r ${where}
    ORDER BY ${orderBy}`;
  const rows = limit > 0
    ? database.prepare(`${sql} LIMIT @limit`).all({ ...params, limit: limit + 1 })
    : database.prepare(sql).all(params);
  const hasMore = limit > 0 && rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const assets = attachAssetTags(
    database,
    projectId,
    annotateAssetStackCovers(
      database,
      pageRows.map((row) => rowToAsset(database, row, { includeRelations: false })),
      projectId,
      { collapsedNodes: true },
    ),
  );
  annotateGalleryNodeSort(assets, pageRows, { collapsed: true, ranked: Boolean(search.searchKind) });
  assets.forEach((asset, index) => {
    if (!asset.stack) return;
    const matchedCount = Number(pageRows[index]?._matched_member_count || 0);
    if (matchedCount > 0 && matchedCount < asset.stack.count) asset.stack.match_count = matchedCount;
  });
  const total = filters.includeTotal === false
    ? null
    : Number(database.prepare(`WITH ${matchedCte} SELECT COUNT(*) AS count FROM matched`).get(params).count || 0);
  const last = pageRows.at(-1);
  return {
    assets,
    page: {
      total,
      nextCursor: hasMore && last ? encodeCursor(last, sort, searchQuery, assetTimeFilterKey(filters)) : null,
      limit: limit || total || pageRows.length,
      sort,
    },
  };
}

function listCollapsedAssetPageFast(database, { filters, projectId, limit, sort, cursor }) {
  if (limit > 0) {
    return listCollapsedAssetPageFastBounded(database, { filters, projectId, limit, sort, cursor });
  }
  const params = { projectId };
  const pageConditions = [];
  if (cursor) {
    params.cursorId = cursor.id;
    params.cursorCreatedAt = cursor.createdAt;
    params.cursorSortName = cursor.sortName;
    if (sort === "name") {
      pageConditions.push("(r._node_sort_name > @cursorSortName OR (r._node_sort_name = @cursorSortName AND r.id > @cursorId))");
    } else if (sort === "oldest") {
      pageConditions.push("(r._node_created_at > @cursorCreatedAt OR (r._node_created_at = @cursorCreatedAt AND r.id > @cursorId))");
    } else {
      pageConditions.push("(r._node_created_at < @cursorCreatedAt OR (r._node_created_at = @cursorCreatedAt AND r.id < @cursorId))");
    }
  }
  const orderBy = sort === "name"
    ? "r._node_sort_name ASC, r.id ASC"
    : sort === "oldest"
      ? "r._node_created_at ASC, r.id ASC"
      : "r._node_created_at DESC, r.id DESC";
  const where = pageConditions.length ? `WHERE ${pageConditions.join(" AND ")}` : "";
  const nodeCtes = `
    active_stack_stats AS MATERIALIZED (
      SELECT sm.stack_id,
        COUNT(*) AS _matched_member_count,
        MIN(sm.position) AS first_position
      FROM asset_stack_members sm
      JOIN assets member ON member.project_id = sm.project_id AND member.id = sm.asset_id
      WHERE sm.project_id = @projectId AND member.archived = 0 AND member.deleted_at IS NULL
      GROUP BY sm.stack_id
    ),
    node_rows AS MATERIALIZED (
      SELECT ${PAGE_ASSET_COLUMNS}, 0 AS _search_score, stats._matched_member_count,
        COALESCE(NULLIF(s.sort_created_at, ''), a.created_at) AS _node_created_at,
        COALESCE(NULLIF(s.sort_name, ''), a.sort_name) AS _node_sort_name
      FROM active_stack_stats stats
      JOIN asset_stack_members cover
        ON cover.project_id = @projectId AND cover.stack_id = stats.stack_id AND cover.position = stats.first_position
      JOIN assets a ON a.project_id = @projectId AND a.id = cover.asset_id
      JOIN asset_stacks s ON s.project_id = @projectId AND s.id = stats.stack_id
      UNION ALL
      SELECT ${PAGE_ASSET_COLUMNS}, 0 AS _search_score, 1 AS _matched_member_count,
        a.created_at AS _node_created_at,
        a.sort_name AS _node_sort_name
      FROM assets a
      LEFT JOIN asset_stack_members sm
        ON sm.project_id = a.project_id AND sm.asset_id = a.id
      WHERE a.project_id = @projectId AND a.archived = 0 AND a.deleted_at IS NULL AND sm.asset_id IS NULL
    )`;
  const sql = `WITH ${nodeCtes}
    SELECT r.* FROM node_rows r ${where}
    ORDER BY ${orderBy}`;
  const rows = limit > 0
    ? database.prepare(`${sql} LIMIT @limit`).all({ ...params, limit: limit + 1 })
    : database.prepare(sql).all(params);
  const hasMore = limit > 0 && rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const assets = attachAssetTags(
    database,
    projectId,
    annotateAssetStackCovers(
      database,
      pageRows.map((row) => rowToAsset(database, row, { includeRelations: false })),
      projectId,
    ),
  );
  annotateGalleryNodeSort(assets, pageRows, { collapsed: true, ranked: false });
  const total = filters.includeTotal === false
    ? null
    : Number(database.prepare(`
      SELECT
        (SELECT COUNT(*)
         FROM assets a
         LEFT JOIN asset_stack_members sm ON sm.project_id = a.project_id AND sm.asset_id = a.id
         WHERE a.project_id = @projectId AND a.archived = 0 AND a.deleted_at IS NULL AND sm.asset_id IS NULL)
        +
        (SELECT COUNT(DISTINCT sm.stack_id)
         FROM asset_stack_members sm
         JOIN assets member ON member.project_id = sm.project_id AND member.id = sm.asset_id
         WHERE sm.project_id = @projectId AND member.archived = 0 AND member.deleted_at IS NULL)
        AS count
    `).get(params).count || 0);
  const last = pageRows.at(-1);
  return {
    assets,
    page: {
      total,
      nextCursor: hasMore && last ? encodeCursor(last, sort, "", assetTimeFilterKey(filters)) : null,
      limit: limit || total || pageRows.length,
      sort,
    },
  };
}

// Task 320 (review 265 中-2): the collapsed, unfiltered gallery recomputed the
// full stack-node table (every stack's member stats + cover) on EVERY page.
// The result now lives in a per-connection temp table refreshed only when the
// cache key moves. The key mirrors navigationStatsCache: project + the store's
// localAssetRevision + PRAGMA data_version. The closure above cannot be seen
// from this module-level function, so its invalidation drops the WeakMap
// entry — entry identity stands in for the revision segment — and the
// data_version segment catches writes made by other connections.
export const galleryStackNodesCacheState = new WeakMap();

function ensureGalleryStackNodesCacheTable(database) {
  database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS gallery_stack_nodes_cache (
      project_id,
      node_asset_id,
      matched_member_count,
      node_created_at,
      node_sort_name,
      PRIMARY KEY (project_id, node_asset_id)
    )
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS gallery_stack_nodes_cache_created_idx
      ON gallery_stack_nodes_cache (project_id, node_created_at, node_asset_id)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS gallery_stack_nodes_cache_name_idx
      ON gallery_stack_nodes_cache (project_id, node_sort_name, node_asset_id)
  `);
}

// One transaction: drop the project's stale rows, then recompute the exact
// stack_nodes shape listCollapsedAssetPageFastBounded used to build inline
// (member stats per stack, cover = lowest active position, sort keys from the
// stack row with the cover's sort_name fallback). Returns the entry stored in
// the cache map; `total` stays null until a caller asks for it, so
// includeTotal:false pages never pay for the count.
function rebuildGalleryStackNodesCache(database, projectId, dataVersion) {
  ensureGalleryStackNodesCacheTable(database);
  database.transaction(() => {
    database.prepare("DELETE FROM gallery_stack_nodes_cache WHERE project_id = @projectId").run({ projectId });
    database.prepare(`
      WITH active_stack_stats AS MATERIALIZED (
        SELECT sm.stack_id,
          COUNT(*) AS _matched_member_count,
          MIN(sm.position) AS first_position
        FROM asset_stack_members sm
        JOIN assets member ON member.project_id = sm.project_id AND member.id = sm.asset_id
        WHERE sm.project_id = @projectId
          AND member.archived = 0
          AND member.deleted_at IS NULL
        GROUP BY sm.stack_id
      )
      INSERT INTO gallery_stack_nodes_cache (project_id, node_asset_id, matched_member_count, node_created_at, node_sort_name)
      SELECT @projectId AS project_id,
        cover.asset_id AS node_asset_id,
        stats._matched_member_count,
        COALESCE(NULLIF(stack.sort_created_at, ''), stack.created_at) AS node_created_at,
        COALESCE(NULLIF(stack.sort_name, ''), cover_asset.sort_name) AS node_sort_name
      FROM active_stack_stats stats
      JOIN asset_stack_members cover
        ON cover.project_id = @projectId
        AND cover.stack_id = stats.stack_id
        AND cover.position = stats.first_position
      JOIN assets cover_asset
        ON cover_asset.project_id = @projectId
        AND cover_asset.id = cover.asset_id
      JOIN asset_stacks stack
        ON stack.project_id = @projectId
        AND stack.id = stats.stack_id
    `).run({ projectId });
  })();
  return { dataVersion, total: null };
}

function listCollapsedAssetPageFastBounded(database, { filters, projectId, limit, sort, cursor }) {
  const params = {
    projectId,
    candidateLimit: limit + 1,
    resultLimit: limit + 1,
  };
  // 320 补充 1：临时表是连接级的，存着本连接打开过的所有项目的节点——页查询
  // 必须按项目过滤，否则别的项目的堆叠占满 LIMIT 把本项目的堆叠卡挤掉
  // （两个索引都以 project_id 打头，条件能走索引）。
  const stackConditions = ["s.project_id = @projectId"];
  const assetConditions = [];
  if (cursor) {
    params.cursorId = cursor.id;
    params.cursorCreatedAt = cursor.createdAt;
    params.cursorSortName = cursor.sortName;
    if (sort === "name") {
      stackConditions.push("(s.node_sort_name > @cursorSortName OR (s.node_sort_name = @cursorSortName AND s.node_asset_id > @cursorId))");
      assetConditions.push("(a.sort_name > @cursorSortName OR (a.sort_name = @cursorSortName AND a.id > @cursorId))");
    } else if (sort === "oldest") {
      stackConditions.push("(s.node_created_at > @cursorCreatedAt OR (s.node_created_at = @cursorCreatedAt AND s.node_asset_id > @cursorId))");
      assetConditions.push("(a.created_at > @cursorCreatedAt OR (a.created_at = @cursorCreatedAt AND a.id > @cursorId))");
    } else {
      stackConditions.push("(s.node_created_at < @cursorCreatedAt OR (s.node_created_at = @cursorCreatedAt AND s.node_asset_id < @cursorId))");
      assetConditions.push("(a.created_at < @cursorCreatedAt OR (a.created_at = @cursorCreatedAt AND a.id < @cursorId))");
    }
  }

  const nodeOrder = sort === "name"
    ? "_node_sort_name ASC, node_asset_id ASC"
    : sort === "oldest"
      ? "_node_created_at ASC, node_asset_id ASC"
      : "_node_created_at DESC, node_asset_id DESC";
  const finalOrder = sort === "name"
    ? "r._node_sort_name ASC, r.id ASC"
    : sort === "oldest"
      ? "r._node_created_at ASC, r.id ASC"
      : "r._node_created_at DESC, r.id DESC";
  const assetIndex = sort === "name" ? "assets_project_name_idx" : "assets_project_created_idx";
  const assetOrder = sort === "name"
    ? "a.sort_name ASC, a.id ASC"
    : sort === "oldest"
      ? "a.created_at ASC, a.id ASC"
      : "a.created_at DESC, a.id DESC";
  const stackWhere = stackConditions.length ? `WHERE ${stackConditions.join(" AND ")}` : "";
  const assetCursor = assetConditions.length ? `AND ${assetConditions.join(" AND ")}` : "";

  // Cache key check (see the WeakMap comment above): same project + unchanged
  // data_version → read the prebuilt node table; otherwise rebuild in one
  // transaction. Reads and the rebuild are synchronous, so the page below can
  // never observe a half-refreshed temp table. MOSA_GALLERY_STACK_NODES_CACHE=off
  // forces a rebuild on every call — the cache-contract test compares both modes.
  const dataVersion = database.pragma("data_version", { simple: true });
  const cacheEnabled = process.env.MOSA_GALLERY_STACK_NODES_CACHE !== "off";
  let cacheState = cacheEnabled ? galleryStackNodesCacheState.get(database) : null;
  if (cacheEnabled && !cacheState) {
    cacheState = new Map();
    galleryStackNodesCacheState.set(database, cacheState);
  }
  let cacheEntry = cacheState?.get(projectId) ?? null;
  if (cacheEntry && cacheEntry.dataVersion !== dataVersion) {
    cacheEntry = null;
  }
  if (!cacheEntry) {
    cacheEntry = rebuildGalleryStackNodesCache(database, projectId, dataVersion);
    if (cacheState) cacheState.set(projectId, cacheEntry);
  }

  const rows = database.prepare(`
    WITH stack_page AS MATERIALIZED (
      SELECT s.node_asset_id,
        s.matched_member_count AS _matched_member_count,
        s.node_created_at AS _node_created_at,
        s.node_sort_name AS _node_sort_name
      FROM gallery_stack_nodes_cache s
      ${stackWhere}
      ORDER BY ${nodeOrder}
      LIMIT @candidateLimit
    ),
    asset_page AS MATERIALIZED (
      SELECT a.id AS node_asset_id,
        1 AS _matched_member_count,
        a.created_at AS _node_created_at,
        a.sort_name AS _node_sort_name
      FROM assets a INDEXED BY ${assetIndex}
      WHERE a.project_id = @projectId
        AND a.archived = 0
        AND a.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM asset_stack_members sm
          WHERE sm.project_id = a.project_id
            AND sm.asset_id = a.id
        )
        ${assetCursor}
      ORDER BY ${assetOrder}
      LIMIT @candidateLimit
    ),
    candidate_nodes AS MATERIALIZED (
      SELECT * FROM stack_page
      UNION ALL
      SELECT * FROM asset_page
    ),
    node_rows AS MATERIALIZED (
      SELECT ${PAGE_ASSET_COLUMNS},
        0 AS _search_score,
        candidates._matched_member_count,
        candidates._node_created_at,
        candidates._node_sort_name
      FROM candidate_nodes candidates
      JOIN assets a
        ON a.project_id = @projectId
        AND a.id = candidates.node_asset_id
    )
    SELECT r.*
    FROM node_rows r
    ORDER BY ${finalOrder}
    LIMIT @resultLimit
  `).all(params);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const assets = attachAssetTags(
    database,
    projectId,
    annotateAssetStackCovers(
      database,
      pageRows.map((row) => rowToAsset(database, row, { includeRelations: false })),
      projectId,
    ),
  );
  annotateGalleryNodeSort(assets, pageRows, { collapsed: true, ranked: false });
  // The cached entry carries this key's total as well: it is only computed
  // when a caller actually asks (includeTotal !== false) and reused until the
  // key moves again. The query itself is byte-identical to the uncached one.
  let total = null;
  if (filters.includeTotal !== false) {
    if (cacheEntry.total == null) {
      cacheEntry.total = Number(database.prepare(`
      SELECT
        (SELECT COUNT(*)
         FROM assets a
         WHERE a.project_id = @projectId
           AND a.archived = 0
           AND a.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM asset_stack_members sm
             WHERE sm.project_id = a.project_id
               AND sm.asset_id = a.id
           ))
        +
        (SELECT COUNT(*)
         FROM asset_stacks stack
         WHERE stack.project_id = @projectId
           AND EXISTS (
             SELECT 1
             FROM asset_stack_members sm
             JOIN assets member
               ON member.project_id = sm.project_id
               AND member.id = sm.asset_id
             WHERE sm.project_id = stack.project_id
               AND sm.stack_id = stack.id
               AND member.archived = 0
               AND member.deleted_at IS NULL
           ))
        AS count
    `).get(params).count || 0);
    }
    total = cacheEntry.total;
  }
  const last = pageRows.at(-1);
  return {
    assets,
    page: {
      total,
      nextCursor: hasMore && last ? encodeCursor(last, sort, "", assetTimeFilterKey(filters)) : null,
      limit,
      sort,
    },
  };
}
