# Third-party notices

This file records upstream projects that materially informed GravityPort's design or implementation. It is separate from GravityPort's own license terms.

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

## ONNX Runtime (onnxruntime-node)

The optional GravityPort Visual Pack executes its verified model through **onnxruntime-node**, the official Node.js binding for ONNX Runtime. This dependency is distributed with the optional visual pack rather than the core `GravityPort.app` bundle.

- Project: `microsoft/onnxruntime`
- Dependency: `onnxruntime-node` (^1.30.0)
- Upstream license: MIT License
- Source: <https://github.com/microsoft/onnxruntime/tree/main/js/node>
- Runtime role: loads the pinned ONNX graph from the verified model pack under Electron `userData` and runs CPU inference inside a dedicated child process.

The MIT license text is available in the upstream repository at <https://github.com/microsoft/onnxruntime/blob/main/LICENSE>.

## Hugging Face Tokenizers (@huggingface/tokenizers)

SigLIP2 SentencePiece tokenization inside the optional visual inference worker uses **@huggingface/tokenizers**, the JavaScript tokenizer package published by Hugging Face. This dependency is distributed with the optional visual pack rather than the core `GravityPort.app` bundle.

- Project: `huggingface/tokenizers` (JavaScript distribution)
- Dependency: `@huggingface/tokenizers` (^0.2.0)
- Upstream license: Apache License 2.0
- Source: <https://github.com/huggingface/tokenizers>
- Runtime role: consumes the tokenizer files pinned in the model pack manifest to produce the fixed-length token ids the visual model expects.

The Apache License 2.0 text is available in the upstream repository at <https://github.com/huggingface/tokenizers/blob/main/LICENSE>.
