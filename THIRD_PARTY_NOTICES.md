# Third-party notices

This file records upstream projects that materially informed GravityPort's design or implementation, and third-party models or runtimes that GravityPort redistributes in its optional packs. It is separate from GravityPort's own license terms.

## APSAL Open

GravityPort's recipe snapshot model was informed by the immutable, reproducible creative-record concepts in **APSAL Open**.

- Project: `henyjone/apsal-open`
- Reference release: `v0.14.0`
- Reference commit: `823f1cbc5557310fa092620391181c1d13485b15`
- Upstream code license: Apache License 2.0
- Upstream author: HenyJone / APSAL Open
- Source: <https://github.com/henyjone/apsal-open/tree/v0.14.0>

The influence is at the design level. In GravityPort, the resulting recipe snapshot system records a frozen generation recipe with content-derived identity, Prompt and recipe digests, normalized reference declarations, provenance, and change lineage. The current GravityPort implementation lives in `lib/recipe-snapshot.ts` and the corresponding storage/API layers.

GravityPort does not vendor, bundle, execute, or depend on APSAL Open source code. No APSAL source files are distributed as part of GravityPort. GravityPort's own source remains licensed under the repository's [PolyForm Noncommercial License 1.0.0](LICENSE); this notice does not relicense GravityPort under Apache-2.0.

APSAL contains substantially broader authoring, protocol, registry, packaging, and Studio functionality. This notice should not be read as claiming those systems are part of GravityPort.

The upstream Apache License 2.0 text is available in APSAL Open's tagged source at <https://github.com/henyjone/apsal-open/blob/v0.14.0/LICENSE>.

## SigLIP2 Base model (optional Visual Pack)

The optional GravityPort Visual Pack redistributes the **SigLIP2 Base** image-text model by Google in the int8 ONNX conversion published by the onnx-community project. GravityPort downloads it only when the user installs the Visual Pack, and runs it locally.

- Model: `google/siglip2-base-patch16-224`
- Redistributed conversion: `onnx-community/siglip2-base-patch16-224-ONNX`, revision `ba1f3b0843f24bc5417d38e19c37b287d719b2f4`
- Files: `onnx/model_int8.onnx` and the tokenizer files pinned by SHA-256 in `scripts/build-visual-model-pack.mjs`
- Upstream license: Apache License 2.0
- Source: <https://huggingface.co/google/siglip2-base-patch16-224>
- Runtime role: produces the image and text embeddings behind local visual search; the pack manifest records the license id and source for every published pack.

## ONNX Runtime (onnxruntime-node)

The optional GravityPort Visual Pack executes its verified model through **onnxruntime-node**, the official Node.js binding for ONNX Runtime. This dependency is distributed with the optional visual pack rather than the core desktop package.

- Project: `microsoft/onnxruntime`
- Dependency: `onnxruntime-node` 1.30.0 (pinned exactly in the pack), together with `onnxruntime-common` 1.30.0 (MIT)
- Upstream license: MIT License
- Source: <https://github.com/microsoft/onnxruntime/tree/main/js/node>
- Runtime role: loads the pinned ONNX graph from the verified model pack under Electron `userData` and runs CPU inference inside a dedicated child process.

The MIT license text is available in the upstream repository at <https://github.com/microsoft/onnxruntime/blob/main/LICENSE>.

## Hugging Face Tokenizers (@huggingface/tokenizers)

SigLIP2 SentencePiece tokenization inside the optional visual inference worker uses **@huggingface/tokenizers**, the JavaScript tokenizer package published by Hugging Face. This dependency is distributed with the optional visual pack rather than the core desktop package.

- Project: `huggingface/tokenizers.js`
- Dependency: `@huggingface/tokenizers` (^0.2.0)
- Upstream license: Apache License 2.0
- Source: <https://github.com/huggingface/tokenizers.js>
- Runtime role: consumes the tokenizer files pinned in the model pack manifest to produce the fixed-length token ids the visual model expects.

The Apache License 2.0 text is available in the upstream repository at <https://github.com/huggingface/tokenizers.js>.
