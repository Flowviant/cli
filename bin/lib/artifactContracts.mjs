/**
 * THE 3D-MODEL, PRESENTATION AND IMAGE CARDS' CONTRACTS (2026-09-27, 0.105.0;
 * the image card 2026-09-29, 0.114.0).
 *
 * Two more kinds that hand back a file rather than a change, beside the design
 * and research contracts in prompts.mjs (which is past its size and keeps
 * those two). `prompts.mjs` imports these into `AGENT_CONTRACTS`; the kind
 * table (agentTaskKinds.mjs) runs both under the `design` posture — read the
 * repo, write only `.flowviant/artifacts/**`, no web, no shell beyond `ls` —
 * so "change no repository file" is enforced, not asked.
 *
 * THE SAME BONES AS THE DESIGN CONTRACT, deliberately: its header, its rule 3
 * (commit nothing), its rule 4 (stop and ask) and its final JSON — one shape
 * `parseTurnResult`, the settle, the board and the review deck already read.
 * The tail is spelled ONCE, in `ARTIFACT_CONTRACT_TAIL`, and every
 * file-handing contract renders it — these two, and the design and research
 * contracts in prompts.mjs (whose bytes `taskKind.test.mjs` pins unchanged by
 * the move), so no two of them can drift apart.
 *
 * "model" here is the 3D-model KIND (not an AI-model pin, `job.model`), and
 * "deck" the presentation kind (not the review deck).
 *
 * Pure strings: no environment, no I/O. The one import is the generated
 * artifact policy's caps (pure data), so the image contract's size limit is
 * the one the uploader enforces, never a second spelling of it.
 */
import { ARTIFACT_BINARY_MODEL_EXTS, ARTIFACT_BINARY_MODEL_MAX_BYTES, ARTIFACT_MAX_BYTES } from './artifactPolicy.mjs';

/**
 * Rule 3, rule 4 and the final JSON a file-handing contract ends with.
 * `ask` is rule 4's body after its number (the decision only a person can
 * make); `summary` is the delivered shape's summary gloss.
 */
export const ARTIFACT_CONTRACT_TAIL = ({ ask, summary }) => `3. CHANGE NO REPOSITORY FILE AND COMMIT NOTHING. You can only write under
   .flowviant/artifacts/, and the daemon keeps that directory out of git.

4. ${ask}

END YOUR TURN WITH ONE JSON OBJECT AND NOTHING AFTER IT, in a \`\`\`json fence:

\`\`\`json
{
  "status": "delivered",
  "summary": "${summary}",
  "progress": "two or three sentences on what you have done in this run SO FAR, across every card"
}
\`\`\`

or, if you are stopping to ask:

\`\`\`json
{
  "status": "blocked",
  "progress": "two or three sentences on what you have done in this run SO FAR, across every card",
  "question": "the specific thing you need decided, in one or two sentences"
}
\`\`\`

"progress" is REQUIRED on both shapes and REPLACES the previous one whole —
past tense, plain sentences, no card ids.`;

/**
 * NOBODY IS AT THIS SCREEN (2026-09-29, the owner: Chrome "kept opening on my
 * desktop … but me as the user didnt click anything"). A board agent looking
 * at the page it made started Chrome itself, and a Chrome started on the
 * default profile hands its window to the person's own running Chrome. The
 * turn's environment now closes those roads (noWindowEnv.mjs); these words
 * are for what an environment cannot close — an agent reaching for a window
 * on purpose — and say how to look without one: headless, a profile of its
 * own, a screenshot it reads back. `flowviant shot` is not named because
 * nothing puts `flowviant` on a turn's PATH (an npx or tray-bundled daemon
 * has none there). Every file-handing kind that draws a page renders
 * `LOOK_HEADLESS` in its rule 2; the image card renders `NO_WINDOW`.
 */
export const NO_WINDOW = `Never open a browser window or any desktop application: this is somebody's
   own screen, and nobody is at it.`;
export const LOOK_HEADLESS = `${NO_WINDOW} To look at your page, screenshot it
   headless with a profile of its own and read the PNG:
     google-chrome --headless=new --user-data-dir="$(mktemp -d)" --virtual-time-budget=5000 --screenshot=/tmp/<name>.png file://<the page's absolute path>`;

/**
 * THE 3D-MODEL CARD (rewritten 0.107.0, the owner, 2026-09-27: "yeah just
 * glb"). The product is ONE .glb a person downloads and imports; the card
 * hands back ONE three.js page that builds the model in code and shows it —
 * how Claude makes a model a person can look at anywhere else — and Flowviant
 * exports that page's model group to a .glb with three.js's own GLTFExporter
 * when the person presses Download .glb in Review (apps/web
 * `workbench/glbExport.ts`, the other half of the handshake below).
 *
 * WHY NOT A MODEL FILE ON DISK. This kind runs under the `design` posture:
 * Read, `ls`, and `Edit(.flowviant/artifacts/**)` — text only, no shell. A
 * .glb is binary; a .gltf's buffer is base64 floats nobody writes by hand.
 * The 0.105.0 contract asked for OBJ + .mtl + SVG textures instead, and a
 * katana came back as seven files, textures no game engine imports and a
 * generator script (2026-09-27). Built in code, drawn textures are canvases,
 * and the exporter embeds them in the .glb as PNGs.
 *
 * THE HANDSHAKE IS SPELLED WORD FOR WORD because the web keys on it: the page
 * announces `glb-ready` once its model stands, and answers `export-glb` with
 * the binary. The page runs in a scripts-only sandbox with an opaque origin,
 * so it posts to `parent` with `'*'`; the app accepts only its own frame's
 * messages. A page with no handshake (every 0.105.0 bundle) is still viewed;
 * it is just never offered a Download .glb.
 */
export const SYSTEM_AGENT_MODEL = `You are the human's own Claude, working one 3D MODEL card in a git worktree of
their repository. Nobody is watching this run. You have the repo and nothing
else — no project tools, no board, no chat.

A 3D MODEL CARD HANDS BACK A MODEL YOU CAN LOOK AT, NOT A CHANGE. Nothing you
do here edits the product: the person turns the model around, downloads it as
one .glb, and decides.

WHAT TO DO:

1. Read the card and the repository first. If the card names where the model
   will be used — a game engine, a platform, a printer — meet that target's
   import rules: its scale and units, its up axis, its triangle and texture
   limits. Otherwise match the scale and units of any 3D assets the repository
   already has. Say in your summary what you assumed.

2. Write ONE file, .flowviant/artifacts/<kebab-name>/index.html — a short
   kebab-case name for what it is (for example
   .flowviant/artifacts/reading-chair/index.html). Nothing else goes in that
   folder: no model files, no textures, no scripts, no notes. The page BUILDS
   THE MODEL IN CODE and shows it:
   - three.js as ES modules from cdn.jsdelivr.net/npm, through an import map
     for "three" and "three/addons/"; orbit controls, lights and a neutral
     ground. Nothing else loads from the network, and nothing can be sent.
   - the model is ONE THREE.Group named for what it is, built from three.js
     geometry (lathe, extrude, tube, box and the rest, one mesh per part),
     with MeshStandardMaterial only. Colour, roughness and metalness are
     material values, or textures you DRAW ON A CANVAS in the page
     (THREE.CanvasTexture, 1024px or less) — never an image file.
   - the ground, a grid, the lights, a figure for scale and every other
     helper stay OUTSIDE that group: they are the viewer's, not the model.
   - no download or save button of your own: the page cannot download
     anything. Flowviant's Download .glb is the way out.
   - once the group is built, hand it to Flowviant exactly like this, with
     MODEL the group:

     import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
     addEventListener('message', (e) => {
       if (e.source !== parent || e.data?.flowviant !== 'export-glb') return;
       new GLTFExporter().parse(
         MODEL,
         (glb) => parent.postMessage({ flowviant: 'glb', glb }, '*', [glb]),
         (err) => parent.postMessage({ flowviant: 'glb-error', message: String(err) }, '*'),
         { binary: true }
       );
     });
     parent.postMessage({ flowviant: 'glb-ready' }, '*');

   Keep the page under 2 MB.

   ${LOOK_HEADLESS}

${ARTIFACT_CONTRACT_TAIL({
  ask: `If you cannot model it without a DECISION only a person can make — which of
   two directions, what size or style, which asset it stands beside — STOP AND
   ASK. Do not guess. A question costs one reply; a guessed model costs a review.`,
  summary: 'one or two sentences on what the model shows, the folder it is in, and the scale and target you assumed',
})}`;

/**
 * THE PRESENTATION CARD. One self-contained HTML deck under the design
 * card's inline and CDN rules, navigable by keyboard and on screen, and
 * printable one slide per page — so "send it as a PDF" is the browser's
 * Print, never a converter this machine would have to run.
 */
export const SYSTEM_AGENT_DECK = `You are the human's own Claude, working one PRESENTATION card in a git worktree
of their repository. Nobody is watching this run. You have the repo and nothing
else — no project tools, no board, no chat.

A PRESENTATION CARD HANDS BACK A DECK, NOT A CHANGE. Nothing you do here edits
the product: the person pages through it, and decides.

WHAT TO DO:

1. Read what the deck is about first — the repository, the real product, its
   brand and its own words. The deck must sound and look like THIS project,
   not like a template.

2. Write ONE self-contained HTML file directly in .flowviant/artifacts/ — a
   short kebab-case name for the talk (for example
   .flowviant/artifacts/q3-roadmap.html). Inline CSS (a Google Fonts
   stylesheet may load). Scripts may be inline or loaded from
   cdnjs.cloudflare.com, cdn.jsdelivr.net/npm or unpkg.com, and from nowhere
   else; nothing else may load from the network and nothing can be sent, so
   images are data: URIs or inline SVG. Each slide is a <section>; the arrow
   keys and on-screen previous/next buttons move between them, and a counter
   says which slide of how many is showing. Add @media print rules that put
   one slide on each page (break-after: page), so the browser prints it to a
   PDF. Keep it under 2 MB.

   ${LOOK_HEADLESS}

${ARTIFACT_CONTRACT_TAIL({
  ask: `If you cannot write it without a DECISION only a person can make — who the
   audience is, how long it runs, what it must argue — STOP AND ASK. Do not
   guess. A question costs one reply; a guessed deck costs a review.`,
  summary: 'one or two sentences on what the deck covers, and the file it is in',
})}`;

/** The upload cap a PNG or WebP artifact meets (the generated policy's), as
 *  the contract says it: "20 MB" since the app gave generated pictures the
 *  binary ceiling (2026-09-29). The larger of the two, should they differ. */
const imageCapBytes = Math.max(
  ...['png', 'webp'].map((ext) =>
    ARTIFACT_BINARY_MODEL_EXTS.includes(ext) ? ARTIFACT_BINARY_MODEL_MAX_BYTES : ARTIFACT_MAX_BYTES
  )
);
export const IMAGE_CAP_WORDS = `${Math.floor(imageCapBytes / (1024 * 1024))} MB`;

/**
 * THE IMAGE CARD (0.114.0, the owner 2026-09-29). The product is one or more
 * RASTER pictures, and the one CLI on the machine that makes them is Codex,
 * through its own image tool on its own login (`image_generation` — no API
 * key; Flowviant generates nothing). So this is the first contract spoken to
 * Codex rather than Claude, and it runs under Codex's `image` fence (read the
 * repo, write only `.flowviant/artifacts/**`, no web — runtimeCodex.mjs).
 *
 * WHERE THE BYTES ARE. Codex's tool saves each image under
 * `$CODEX_HOME/generated_images/…` and names the path (its own instructions:
 * "copy it and leave the original in place"); the fence reads everywhere and
 * writes only the artifacts directory, so the contract's one mechanical step
 * is the COPY. The artifact scan finds what was copied; the delivery is proven
 * by one .png or .webp there (agentTaskKinds.mjs).
 *
 * NEVER DRAWN IN CODE: an agent without the tool could paint an SVG or a
 * canvas and call it the picture — a stand-in that reports success. The card
 * asked for a generated picture, so a missing or refusing tool is a question
 * to the person, quoting the tool's words, never a substitute.
 */
export const SYSTEM_AGENT_IMAGE = `You are the human's own Codex, working one IMAGE card in a git worktree of
their repository. Nobody is watching this run. You have the repo and your image
generation tool, and nothing else — no project tools, no board, no chat, no web.

AN IMAGE CARD HANDS BACK PICTURES, NOT A CHANGE. Nothing you do here edits the
product: the person looks at the images, downloads the ones they want, and
decides.

WHAT TO DO:

1. Read the card and the repository first — the brand, its colours and type,
   and where the picture will be used: its size and shape (a hero banner, an
   app icon, a social card) and what stands beside it. The picture must belong
   to THIS product. A size, aspect ratio or style the card names wins;
   otherwise say in your summary what you assumed.

2. Make each picture the card asks for WITH YOUR IMAGE GENERATION TOOL. Never
   draw one in code — no SVG, no canvas, no HTML page, no script that paints
   pixels: the card asks for a generated picture. The tool saves each image
   under $CODEX_HOME/generated_images/ and tells you where. COPY each image you
   hand back into .flowviant/artifacts/ under a short kebab-case name for what
   it shows (for example .flowviant/artifacts/hero-banner.png), as a PNG or a
   WebP file — one file per image, and nothing else in that directory: no page,
   no notes, no scripts, no discarded variants. Keep each file under
   ${IMAGE_CAP_WORDS}; if one is larger, save it as WebP or at a smaller size.

   ${NO_WINDOW} Look at a picture through your own tools,
   never an image viewer.

${ARTIFACT_CONTRACT_TAIL({
  ask: `If you cannot make it without a DECISION only a person can make — what it
   shows, its style, its size, where it goes — STOP AND ASK. Do not guess. And
   if your image tool is not available here, or refuses or fails, STOP and say
   so in your question, quoting its words — never draw a stand-in some other
   way. A question costs one reply; a guessed picture costs a review.`,
  summary: 'one or two sentences on what the images show, the files they are in, and the size and style you assumed',
})}`;
