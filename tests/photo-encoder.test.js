/* FOODAY — unit tests for the photo encoder in app.js.
 *
 * `shrinkPhoto` decides what a picked image is re-encoded to: a photograph
 * becomes a JPEG, a PNG that can stay lossless stays a PNG, and a PNG with real
 * transparency keeps its alpha. That decision is what these tests pin down.
 *
 * app.js is a browser script, so it is loaded into a `node:vm` sandbox with a
 * fake canvas instead of a real one. The fake `toDataURL` returns a string of a
 * length the test chooses, which is exactly what makes the format decision
 * observable — the encoder's only input besides the image is whether its output
 * fits under the byte ceiling.
 *
 * Run with:  node --test tests/
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS = path.join(__dirname, "..", "app.js");

/**
 * Loads app.js in a sandbox and hands back the photo encoder, the fake canvas
 * call log, and the encoder's own limits.
 *
 * @param {object} options
 * @param {(call: {type: string, quality: number|undefined, width: number, height: number}) => number} options.sizeOf
 *        How many characters `toDataURL` should return for one encode.
 * @param {number} [options.alpha]  Alpha the fake pixels report. 255 = opaque.
 */
function loadEncoder({ sizeOf, alpha = 255 }) {
  const log = [];

  // A fresh canvas per call, so each encode attempt is its own record: that is
  // how "PNG tried once" is told apart from "PNG scaled down and retried".
  const makeCanvas = () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (source, x, y, w, h) => log.push({ kind: "drawImage", w, h, source }),
        getImageData: (x, y, w, h) => {
          log.push({ kind: "getImageData", w, h });
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 3; i < data.length; i += 4) data[i] = alpha;
          return { data };
        },
      }),
      toDataURL: (type, quality) => {
        const call = { type, quality, width: canvas.width, height: canvas.height };
        log.push({ kind: "toDataURL", ...call });
        return `data:${type};base64,${"A".repeat(Math.max(0, sizeOf(call)))}`;
      },
    };
    return canvas;
  };

  const sandbox = {
    console,
    document: {
      createElement: () => makeCanvas(),
      getElementById: () => null,
      addEventListener: () => {},
      hidden: false,
      title: "",
    },
    createImageBitmap: async (file) => ({
      width: file.w,
      height: file.h,
      close: () => log.push({ kind: "close" }),
    }),
    addEventListener: () => {},
    fetch: () => Promise.reject(new Error("no network in tests")),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { geolocation: null, permissions: null, userAgent: "node", language: "en" },
    setTimeout,
    clearTimeout,
    AbortController,
    URL,
    Image: function Image() {},
    FileReader: function FileReader() {},
    alert: () => {},
    confirm: () => false,
    prompt: () => null,
  };
  sandbox.window = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, "utf8"), ctx, { filename: APP_JS });

  const [
    shrinkPhoto,
    photoMayHaveAlpha,
    photoHasAlpha,
    PHOTO_MAX_EDGE,
    PHOTO_PRODUCT_EDGE,
    PHOTO_ALPHA_EDGE,
    PHOTO_MAX_BYTES,
  ] = vm.runInContext(
    "[shrinkPhoto, photoMayHaveAlpha, photoHasAlpha, PHOTO_MAX_EDGE, PHOTO_PRODUCT_EDGE, PHOTO_ALPHA_EDGE, PHOTO_MAX_BYTES]",
    ctx
  );

  return {
    shrinkPhoto,
    photoMayHaveAlpha,
    photoHasAlpha,
    log,
    // Every encode attempt, in order, with the canvas it was drawn on.
    encodes: () => log.filter(e => e.kind === "toDataURL"),
    PHOTO_MAX_EDGE,
    PHOTO_PRODUCT_EDGE,
    PHOTO_ALPHA_EDGE,
    PHOTO_MAX_BYTES,
  };
}

/** 2000×1500, as a phone camera would hand it over. */
const jpegFile = () => ({ type: "image/jpeg", name: "photo.jpg", size: 4_000_000, w: 2000, h: 1500 });
const pngFile = () => ({ type: "image/png", name: "logo.png", size: 900_000, w: 2000, h: 1500 });

/** Whatever is asked for fits, so only the format choice is under test. */
const alwaysFits = () => 1000;

test("a JPEG is re-encoded as a JPEG, and its pixels are never scanned", async () => {
  const env = loadEncoder({ sizeOf: alwaysFits });
  const url = await env.shrinkPhoto(jpegFile());

  assert.match(url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(env.encodes().map(e => e.type), ["image/jpeg"]);
  assert.equal(env.encodes()[0].quality, 0.82, "the best quality is tried first");
  assert.equal(env.log.some(e => e.kind === "getImageData"), false, "no alpha scan for a format that cannot carry alpha");
});

test("a JPEG steps its quality down until the data URL fits", async () => {
  // Only the lowest quality is small enough.
  const env = loadEncoder({ sizeOf: ({ quality }) => (quality <= 0.5 ? 1000 : 2_000_000) });
  const url = await env.shrinkPhoto(jpegFile());

  assert.match(url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(env.encodes().map(e => e.quality), [0.82, 0.7, 0.6, 0.5]);
});

test("a photograph is never re-encoded as a PNG, however small it is", async () => {
  const env = loadEncoder({ sizeOf: alwaysFits });
  await env.shrinkPhoto(jpegFile());

  assert.equal(env.encodes().some(e => e.type === "image/png"), false);
});

test("an opaque PNG stays a PNG: one attempt, full size, no quality dial", async () => {
  const env = loadEncoder({ sizeOf: alwaysFits, alpha: 255 });
  const url = await env.shrinkPhoto(pngFile(), env.PHOTO_PRODUCT_EDGE);

  assert.match(url, /^data:image\/png;base64,/);
  assert.equal(env.encodes().length, 1, "an opaque PNG is never scaled down just to stay a PNG");

  const [only] = env.encodes();
  assert.equal(only.type, "image/png");
  assert.equal(only.quality, undefined, "PNG is encoded without a quality argument");
  assert.equal(only.width, 1000, "2000 px wide, scaled to the 1000 px product edge");
  assert.equal(only.height, 750, "the aspect ratio is kept");
});

test("a transparent PNG keeps its alpha and trades resolution to fit", async () => {
  // Nothing above the 320 px floor is small enough, so every step is taken.
  const env = loadEncoder({ sizeOf: ({ width }) => (width <= 320 ? 1000 : 2_000_000), alpha: 0 });
  const url = await env.shrinkPhoto(pngFile(), env.PHOTO_PRODUCT_EDGE);

  assert.match(url, /^data:image\/png;base64,/);
  assert.equal(env.log.some(e => e.kind === "getImageData"), true, "the pixels are inspected");

  const widths = env.encodes().map(e => e.width);
  assert.deepEqual(widths, [1000, 750, 563, 422, 320], "each retry is 75% of the last, down to the 320 px floor");
  assert.equal(env.encodes().every(e => e.type === "image/png"), true);
});

test("an opaque PNG too heavy to keep falls back to a JPEG", async () => {
  const env = loadEncoder({ sizeOf: ({ type }) => (type === "image/png" ? 2_000_000 : 1000), alpha: 255 });
  const url = await env.shrinkPhoto(pngFile(), env.PHOTO_PRODUCT_EDGE);

  assert.match(url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(
    env.encodes().map(e => e.type),
    ["image/png", "image/jpeg"],
    "one PNG attempt at full size, then JPEG — never a scaled-down PNG"
  );
  assert.equal(env.encodes()[0].width, 1000);
});

test("a transparent PNG that cannot fit at any size still uploads, as a JPEG", async () => {
  const env = loadEncoder({ sizeOf: ({ type }) => (type === "image/png" ? 2_000_000 : 1000), alpha: 0 });
  const url = await env.shrinkPhoto(pngFile(), env.PHOTO_PRODUCT_EDGE);

  assert.match(url, /^data:image\/jpeg;base64,/);

  const types = env.encodes().map(e => e.type);
  assert.equal(types.filter(t => t === "image/png").length, 5, "every PNG size was tried before giving up");
  assert.equal(types[types.length - 1], "image/jpeg", "refusing the upload is never the answer");
});

test("an image that cannot fit even as a JPEG is reported, not uploaded", async () => {
  const env = loadEncoder({ sizeOf: () => 2_000_000 });
  assert.equal(await env.shrinkPhoto(jpegFile()), "");
});

test("a small image is never enlarged", async () => {
  const env = loadEncoder({ sizeOf: alwaysFits });
  await env.shrinkPhoto({ type: "image/jpeg", size: 2000, w: 300, h: 200 }, env.PHOTO_PRODUCT_EDGE);

  const [only] = env.encodes();
  assert.equal(only.width, 300);
  assert.equal(only.height, 200);
});

test("the profile edge is smaller than the product edge", async () => {
  const env = loadEncoder({ sizeOf: alwaysFits });
  await env.shrinkPhoto({ type: "image/jpeg", size: 4000, w: 2000, h: 1500 }, env.PHOTO_MAX_EDGE);

  assert.equal(env.encodes()[0].width, 720);
  assert.ok(env.PHOTO_MAX_EDGE < env.PHOTO_PRODUCT_EDGE);
});

test("the encoder's ceiling stays under the strictest server limit", () => {
  const env = loadEncoder({ sizeOf: alwaysFits });
  // api/account.php refuses a profile picture whose data URL exceeds 2,000,000
  // bytes; api/products.php allows 4,000,000. Staying under the smaller of the
  // two keeps every payload acceptable to both.
  assert.ok(env.PHOTO_MAX_BYTES < 2_000_000);
});

test("only formats that can carry alpha are offered the lossless path", () => {
  const env = loadEncoder({ sizeOf: alwaysFits });

  assert.equal(env.photoMayHaveAlpha("image/jpeg"), false);
  assert.equal(env.photoMayHaveAlpha(""), false);
  assert.equal(env.photoMayHaveAlpha(undefined), false);
  assert.equal(env.photoMayHaveAlpha("image/png"), true);
  assert.equal(env.photoMayHaveAlpha("image/webp"), true);
  assert.equal(env.photoMayHaveAlpha("image/gif"), true);
});

test("a nearly-opaque pixel is not treated as transparency", () => {
  // Anti-aliased edges leave alpha just under 255; re-encoding those as PNG
  // would turn ordinary photographs into enormous files.
  const nearly = loadEncoder({ sizeOf: alwaysFits, alpha: 254 });
  assert.equal(nearly.photoHasAlpha({ width: 10, height: 10 }), false);

  const clear = loadEncoder({ sizeOf: alwaysFits, alpha: 249 });
  assert.equal(clear.photoHasAlpha({ width: 10, height: 10 }), true);
});

test("a file that is not an image is refused before any canvas work", async () => {
  const env = loadEncoder({ sizeOf: alwaysFits });

  assert.equal(await env.shrinkPhoto({ type: "application/pdf", size: 1000 }), "");
  assert.equal(await env.shrinkPhoto(null), "");
  assert.equal(env.log.length, 0, "nothing was drawn, scanned or encoded");
});

test("an absurdly large file is refused before it is decoded", async () => {
  const env = loadEncoder({ sizeOf: alwaysFits });
  assert.equal(await env.shrinkPhoto({ type: "image/jpeg", size: 40_000_000 }), "");
  assert.equal(env.log.length, 0);
});
