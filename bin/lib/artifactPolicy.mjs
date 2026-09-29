/**
 * THE ARTIFACT POLICY — GENERATED, DO NOT EDIT BY HAND.
 *
 * Rendered from the server's packages/shared/src/schemas/artifact.schema.ts
 * by flowviant's packages/shared/src/schemas/daemonArtifactPolicy.ts
 * (`bun scripts/write-daemon-artifact-policy.ts` in the app repo). The server
 * is the release source; its parity test fails until this file matches it.
 * artifacts.mjs reads the allowlist and the caps from here, and the server
 * still verifies every upload on its own.
 */

export const ARTIFACT_POLICY_SOURCE = 'packages/shared/src/schemas/artifact.schema.ts';

/** Per text file and ordinary binary artifact. */
export const ARTIFACT_MAX_BYTES = 2097152;
/** Binary model buffers (the extensions below). */
export const ARTIFACT_BINARY_MODEL_MAX_BYTES = 20971520;
export const ARTIFACT_BINARY_MODEL_EXTS = ['glb', 'bin', 'png', 'webp'];
/** Per session and per agent — the server keeps as many per owner. */
export const ARTIFACT_MAX_PER_OWNER = 40;

/** Extension → the one mime the server serves it under; `text` is scrubbed. */
export const ARTIFACT_TYPES = {
  html: { mime: 'text/html', text: true },
  htm: { mime: 'text/html', text: true },
  md: { mime: 'text/markdown', text: true },
  svg: { mime: 'image/svg+xml', text: true },
  png: { mime: 'image/png', text: false },
  jpg: { mime: 'image/jpeg', text: false },
  jpeg: { mime: 'image/jpeg', text: false },
  gif: { mime: 'image/gif', text: false },
  webp: { mime: 'image/webp', text: false },
  json: { mime: 'application/json', text: true },
  csv: { mime: 'text/csv', text: true },
  txt: { mime: 'text/plain', text: true },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text: false },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', text: false },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', text: false },
  pdf: { mime: 'application/pdf', text: false },
  gltf: { mime: 'model/gltf+json', text: true },
  obj: { mime: 'model/obj', text: true },
  mtl: { mime: 'model/mtl', text: true },
  glb: { mime: 'model/gltf-binary', text: false },
  bin: { mime: 'application/octet-stream', text: false },
};
