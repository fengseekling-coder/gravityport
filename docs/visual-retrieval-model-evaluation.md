# Visual Retrieval Model Evaluation

Status: SigLIP2 Base passed this gate and ships as the optional Visual Pack (since 0.2.1-rc.25). This document keeps the evaluation record and the gate that any future candidate must pass.

GravityPort's current text search already covers explicit keywords, supported Chinese conversational phrasing, and a small audited design vocabulary. The remaining retrieval gap is pixel-grounded intent: composition, subject position, color placement, and other facts that are not present in Prompt or metadata.

## Default product runtime

The default product architecture is **GravityPort-local**, not Ollama. The desktop app owns discovery and verification of optional model packs under Electron `userData`, exposes their state in Settings, and keeps installation/enabled/runtime-readiness as separate states. A verified model pack does not become usable until GravityPort also has a compatible trusted local inference runtime.

Ollama is not part of the default dependency chain and the normal UI must not instruct users to install or start it. A future external-provider integration may be added for advanced users, but it must implement the same pinned `encodeImage` / `encodeText` contract and cannot weaken model-id/revision/dimension checks.

When no model pack is installed, the rest of GravityPort runs normally. When a pack exists but no compatible local runtime is present, Settings reports that state explicitly rather than pretending visual search is available.

## Product constraints

Any model considered for GravityPort visual retrieval must satisfy all of these constraints before product integration:

- Local inference after installation of an optional model pack. User assets must not be uploaded for retrieval.
- Model weights and runtime must be legally usable for product development and potential commercial distribution. A strong benchmark score cannot override a restrictive model license.
- The base GravityPort desktop package must not silently grow by hundreds of megabytes. Model packs should remain optional and live outside the user's asset library so normal library backup/restore does not duplicate model weights.
- Image embeddings are computed in the background. The renderer must not own a long-running inference loop.
- Query and indexing results must use the same pinned model/version and preprocessing configuration. A model update requires an embedding-version migration rather than mixing vector spaces.
- Missing or stale image embeddings must degrade to existing lexical search instead of hiding assets.

## Current candidate screen

The following screen was checked on 2026-09-18. Re-check upstream licenses and files before any model download or redistribution.

| Candidate | Current status | Why |
| --- | --- | --- |
| SigLIP2 Base (ONNX int8, onnx-community) | **First integrated candidate** | Apache-2.0, Apple Silicon CPU latency within the gate, and the Gemma-based 256k tokenizer gives usable Chinese retrieval. The int8 combined graph is 378 MB, inside the pack budget. See the measured results below. |
| SigLIP v1 Base (ONNX, Xenova) | **Fallback candidate** | Apache-2.0 and a proven export, but the 32k tokenizer has no Chinese coverage: every Chinese query collapses to an identical embedding. English-only retrieval works. |
| Apple MobileCLIP2 | **Excluded from product evaluation** | The model-weight license is limited to research purposes and explicitly excludes product development and commercial products/services. Its efficiency does not override that restriction. |
| Jina CLIP v2 | **Excluded from bundled/local product use without separate license** | The downloadable model is CC BY-NC 4.0; the model card directs commercial users to separate commercial channels. |
| BAAI AltCLIP | **Deferred on footprint** | The model card permits commercial redistribution under CreativeML OpenRAIL-M conditions, but the current checkpoint is multi-gigabyte and does not fit the first model-pack budget without a verified smaller conversion. |

Primary upstream references:

- SigLIP2 model: https://huggingface.co/google/siglip2-base-patch16-224
- SigLIP2 ONNX conversion: https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX
- MobileCLIP2 model license: https://github.com/apple-aiml-research/ml-mobileclip/blob/main/LICENSE_MODELS
- Jina CLIP v2 model card/license: https://huggingface.co/jinaai/jina-clip-v2
- AltCLIP model card/license: https://huggingface.co/BAAI/AltCLIP

## Measured results (2026-09-18, Apple Silicon, onnxruntime-node 1.30.0)

Environment: darwin/arm64, Node 22, CPU execution provider. The reference
ground truth was produced by the original PyTorch model (`transformers`
4.57) on the same real photos.

- Pack: `siglip2-base-patch16-224`, upstream revision `ba1f3b08`, int8 combined graph 378 MB, 768-d embeddings, Apache-2.0. Total pack with tokenizer/config files: 412.4 MB.
- Cold worker start (pack re-verification + tokenizer + session load): ~1.0–3.5 s (gate: 8 s).
- Warm image encode (through the IPC worker, including preprocessing): p95 ≈ 48 ms (gate: 250 ms).
- Warm text encode (through the IPC worker): p95 ≈ 15 ms (gate: 250 ms).
- Exact Top-20 cosine scan, 768-d: 1k ≈ 2.6 ms, 10k ≈ 5.3 ms, 50k ≈ 26 ms P95 (gate: 60 ms at target scale). Exact search stays; no ANN index.
- Worker process RSS: ~780–1340 MB (gate: 1536 MB). The Gemma tokenizer's JS vocabulary is the largest fixed cost.
- Retrieval: Hit@1 = 5/5 English and 5/5 Chinese on a five-photo semantic set (football/bee/beetle/city/tiger) with the fixed-length text recipe below; the PyTorch reference scores 5/5 on the same set.
- Determinism: identical inputs produce bit-identical embeddings (max |Δ| = 0).

Two non-obvious findings that cost the most time; any future model or
conversion must be re-verified against them:

1. **Fixed-length text inputs are mandatory.** The community ONNX exports
   reproduce the upstream text space only when `input_ids` are padded to
   `max_text_tokens` (64) with the pad token. Variable-length inputs load and
   run fine but silently corrupt cross-modal alignment (text vectors drift to
   ≈0.54 cosine from the PyTorch reference; retrieval margins collapse). The
   same behaviour reproduces through transformers.js 3.8, so it belongs to the
   export convention, not to any single consumer.
2. **The separated `text_model.onnx` / `vision_model.onnx` subgraphs are not
   usable for retrieval.** They emit the pre-projection hidden pools; the
   projection heads only exist in the combined `model.onnx` graph. Subgraph
   outputs are individually self-consistent (intra-modal similarity looks
   healthy) while cross-modal similarity is near-orthogonal — do not mistake
   that for a working retrieval model. The pack therefore pins the combined
   graph.

Earlier screening notes that were corrected by measurement: the initial
evaluation described SigLIP2 as explicitly multilingual; the published
`siglip2-*` checkpoints are English-trained, and the usable Chinese retrieval
comes from the Gemma tokenizer's multilingual vocabulary, not from dedicated
multilingual training. Chinese quality is usable but should be re-scored on a
broader private corpus before release.

## Candidate report contract

Model experiments must emit a JSON report using schema `mosa.visual-retrieval-candidate/1`:

```json
{
  "schema": "mosa.visual-retrieval-candidate/1",
  "candidate": {
    "id": "siglip2-base-example",
    "model_id": "upstream/model-id",
    "license_id": "apache-2.0",
    "license_source": "https://example.invalid/license",
    "commercial_product_use": true,
    "model_pack_bytes": 400000000,
    "runtime_bytes": 80000000
  },
  "environment": {
    "platform": "darwin",
    "arch": "arm64",
    "device": "Apple Silicon model"
  },
  "measurements": {
    "cold_start_ms": 2200,
    "warm_query_ms": [120, 125, 130],
    "image_index_ms": [130, 140, 145],
    "vector_search_ms": [35, 40, 42],
    "peak_rss_mb": 900
  },
  "queries": [
    {
      "id": "visual-right-side-person",
      "ranked_asset_ids": ["asset-a", "asset-b"]
    }
  ]
}
```

Run:

```bash
npm run qa:visual-retrieval-candidate -- --input /absolute/path/to/candidate-report.json
```

The evaluator joins candidate results to `test/fixtures/retrieval-acceptance.json`; a candidate cannot choose easier query IDs.

## Provisional gate

The current hard gate is deliberately conservative:

- commercial/product-use license confirmed;
- model pack <= 512 MiB;
- added runtime <= 256 MiB;
- peak RSS <= 1536 MiB;
- cold start <= 8 s;
- warm text-query P95 <= 250 ms;
- image-index P95 <= 250 ms/image;
- exact vector Top-K P95 <= 60 ms at the target library scale;
- synthetic visual Hit@1 >= 75%;
- synthetic visual Hit@5 = 100%.

Passing this gate only earns a candidate the next stage. The current visual fixture is intentionally small and synthetic; it is not enough evidence to ship a model. Before release, expand it with a private, opt-in evaluation corpus outside the repository and report aggregate metrics only. Never commit user assets or derived embeddings.

The evaluator therefore exposes a separate `decision.release_ready` gate instead of treating the synthetic candidate gate as a shipping approval. Release validation currently requires at least 20 visual queries, including at least 5 Chinese (`zh`) and 5 English (`en`) queries, and requires each language slice to reach Hit@1 >= 75% in addition to the base latency, footprint, license, and overall retrieval gates. A query may declare `locale`; otherwise the evaluator classifies CJK text as `zh` and other text as `en`. These minimums are a floor for catching language regressions, not evidence that five examples represent production quality; the broader private corpus remains required.

## Vector-search baseline

The first implementation should prefer exact search until scale proves otherwise. Run:

```bash
npm run benchmark:vector-search
```

The benchmark uses 50,000 normalized 512-dimensional vectors by default. It measures only Top-K vector scanning, not model encoding. If exact search remains within the interaction budget, GravityPort avoids an ANN index, another native dependency, and index-rebuild complexity in the first release.

Environment overrides:

```bash
MOSA_VECTOR_BENCH_ASSETS=100000 MOSA_VECTOR_BENCH_DIMENSION=768 npm run benchmark:vector-search
```

## Integration sequence after a candidate passes

1. Pin the model, tokenizer/preprocessor, conversion revision, checksums, and license notice in a model-pack manifest.
2. Keep model weights in desktop `userData`, not in `GravityPort Library`.
3. Add a background embedding worker and versioned SQLite embedding metadata.
4. Backfill image embeddings incrementally with pause/resume and thermal/battery awareness.
5. Encode only the query at search time, then exact-scan normalized vectors.
6. Merge visual results with the existing lexical result set without replacing explicit keyword matches.
7. Add user controls to remove the optional model pack and derived embeddings without touching original assets or provenance.

Do not implement automatic model downloads until licensing, checksum verification, disk-space handling, and explicit user consent are part of the same change.

## Visual relationship engine boundary

The product integration is model-neutral. Visual embeddings are derived cache data stored under Electron `userData`, namespaced by library path and pinned model id/revision/dimension. They do not live in `GravityPort Library` and are not part of normal library backup.

The first relationship surfaces are intentionally advisory:

- image-to-image visual neighbors;
- near-duplicate candidates;
- version candidates;
- Stack candidates.

Candidates return their similarity score, explicit provisional thresholds, and whether GravityPort already knows a direct version relation. They never automatically merge assets, create a Stack, or modify version lineage. The current provisional similarity thresholds are `0.985` for near-duplicate candidates, `0.94` for version candidates, and `0.90` for Stack candidates. These values must be recalibrated on the eventual production model and a broader evaluation corpus before release.

Runtime API contracts are stable even without a model pack: `/api/visual/status` reports the feature as unavailable, while model-dependent relationship requests fail explicitly instead of altering normal library behavior.

The embedding build path is also model-neutral. A background worker accepts any provider exposing `encodeImage`, skips embeddings that are already current for the pinned model/content hash, records only derived vectors, contains per-asset failures, and supports pause/resume/stop semantics. Deleted or otherwise stale asset ids can be pruned from the derived index without touching the source library. This keeps the future model runtime isolated from GravityPort's source-of-truth asset store.

Image and text inference share one validated provider contract. The provider must expose both `encodeImage` and `encodeText`, and its model id, revision, and embedding dimension must exactly match the relationship index. GravityPort rejects a mismatched vector space instead of comparing embeddings produced by different models. Provider startup is lazy and provider shutdown is owned by the runtime lifecycle.

With a compatible provider configured, `/api/visual/search?q=...` performs text-to-image retrieval against the same versioned image vectors used by image-to-image similarity. The existing lexical search remains independent; visual text search is an optional capability and does not replace explicit Prompt/tag matches.

## Local inference runtime and pack installation

The optional Visual Pack is self-contained: it carries the pinned SigLIP2 model,
ONNX Runtime through `onnxruntime-node` (MIT), and
`@huggingface/tokenizers` (Apache-2.0) for SentencePiece tokenization. These
visual-only runtime dependencies are deliberately excluded from `GravityPort.app`, so
users who never enable local visual search do not pay the ONNX Runtime install
size. Inference still runs in a dedicated forked child process
(`lib/visual-inference-worker-entry.mjs`) reached only through
`lib/visual-inference-client.mjs`: bounded request queue, per-request timeouts,
request-id correlation, crash detection, and a fail-closed posture (a dead or
hung worker rejects work with coded errors and is never silently respawned).
The renderer has no access to this channel and never handles model or asset
file paths. No Python, Ollama, or other separately installed daemon is required.

A platform-specific pack is built from the pinned candidate plus the matching
local runtime, with every model/runtime file digested into the manifest:

```bash
node scripts/build-visual-model-pack.mjs --source <downloaded-files-dir> \
  --runtime-target darwin-arm64 \
  --output "$HOME/Library/Application Support/mosa/visual-model-packs/siglip2-base-patch16-224"
npm exec gravityport -- visual-model-verify --from "$HOME/Library/Application Support/mosa/visual-model-packs/siglip2-base-patch16-224"
```

The examples use the `gravityport` command name; the legacy `mosa` name still works and points at the same `bin/mosa.mjs` entry.

Use `--runtime-target win32-x64` for the Windows pack. `--model-only` remains a
development/evaluation escape hatch; a production packaged GravityPort build requires
the runtime-bearing pack before visual search can become ready.

Packaged GravityPort also supports an explicit one-click Settings flow. The renderer
cannot supply a URL or filesystem destination. The main process reads the same
first-party release feed used by application updates, selects only the entry
matching the current platform/architecture, and downloads files only from:

`https://mosa.azhuilab.com/downloads/visual-packs/<id>/<revision>/<target>/...`

The release feed pins `model-pack.json` by byte size and SHA-256. After that
manifest is verified, each model/runtime file is downloaded into a private
`userData` staging directory and checked against the manifest's own byte size
and SHA-256 before installation. Installation checks free disk space first,
uses an atomic directory swap for the selected revision, preserves the previous
working revision on failure, and selects the new revision only after
`verifyVisualModelPack()` passes. GravityPort restarts after a successful install so
the library runtime starts against one coherent model identity. Older revisions
of the same model are cleaned after the new process has started. Removing the
pack first disables/stops visual inference, removes the optional pack and the
derived visual relationship index, and never touches source assets, Prompt, or
provenance records.

The release-feed fragment for a platform is intentionally small and contains
no arbitrary download URL:

```json
{
  "visualPacks": {
    "darwin-arm64": {
      "id": "siglip2-base-patch16-224",
      "revision": "<pinned-upstream-revision>",
      "totalSize": 0,
      "manifest": { "size": 0, "sha256": "<64-hex>" },
      "license": { "id": "apache-2.0", "source": "https://..." }
    }
  }
}
```

`scripts/build-visual-model-pack.mjs` prints the exact
`release_manifest_patch` for the pack it produced, so release publishing does
not require hand-calculating sizes or hashes.

After a restart, Settings reports the real runtime state machine:
`not-installed`, `disabled`, `loading`, `ready`, `runtime-unavailable`, or
`error`. Runtime availability is measured by starting the active verified pack
inside the inference worker, never assumed from a build flag or from files in
the main application bundle.

Benchmarks for the integrated candidate are reproducible with:

```bash
node scripts/benchmark-visual-inference.mjs --pack <pack-dir>
```

The optional `MOSA_VISUAL_SMOKE_PACK` environment variable runs the real
inference smoke test (`test/visual-inference-smoke.test.mjs`) against an
installed pack; without it the test skips so CI stays offline.

## Offline model-pack verification

Candidate weights that already exist locally can be arranged as a GravityPort visual model pack and verified without network access:

```bash
npm exec gravityport -- visual-model-verify --from /absolute/path/to/model-pack
```

The pack root contains `model-pack.json` with schema `mosa.visual-model-pack/1`. The manifest pins an id, revision, `image-text-embedding` model type, embedding dimension, product-use license declaration, preprocessing metadata, the runtime provider/version/platform/architecture, and every model/runtime file's relative path, role, byte size, and SHA-256 digest. Verification rejects absolute/traversal paths, duplicate entries, symlinks, size mismatches, hash mismatches, missing license fields, unconfirmed product use, unsupported or host-mismatched runtime targets, runtime-package version drift, and first-stage packs above 512 MiB.

Verified packs are intended to live under `<Electron userData>/visual-model-packs`, not under `GravityPort Library`. The library therefore remains portable and its backup does not silently duplicate model weights.
