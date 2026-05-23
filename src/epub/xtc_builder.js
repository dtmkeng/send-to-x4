/**
 * XTC Builder — CREngine edition
 * Renders article via CREngine WASM (same engine as bigbag/epub-to-xtc-converter).
 * Pipeline: article → EPUB (JSZip) → CREngine render → Floyd-Steinberg dither → XTG/XTC.
 *
 * Requires in popup.html (loaded before this script):
 *   <script src="../epub/jszip.min.js"></script>
 *   <script src="../epub/crengine.js"></script>
 *
 * Requires in extension bundle:
 *   assets/wasm/crengine.wasm  (from bigbag/epub-to-xtc-converter/web/crengine.wasm)
 */
const XtcBuilder = {
    PAGE_W: 480,
    PAGE_H: 800,

    // CREngine rendering settings — identical to reference encoder defaults
    CR_FONT_SIZE:   28,
    CR_LINE_HEIGHT: 120,   // percent (120 = 1.2×)
    CR_MARGIN:      16,
    CR_FONT_WEIGHT: 400,
    CR_TEXT_ALIGN:  3,     // 3 = justify

    _wasmBinary:       null,  // cached ArrayBuffer of crengine.wasm
    _crengineCode:     null,  // cached text of crengine.js (eval'd in sandbox)
    _fontData:         null,  // cached ArrayBuffer of NotoSansThai.ttf
    _sandboxIframe:    null,  // hidden iframe pointing to crengine_sandbox.html
    _sandboxLoadPromise: null,// Promise that resolves when iframe finishes loading
    _sandboxReady:     false, // sandbox has successfully initialised CREngine

    /**
     * Build XTC ArrayBuffer from article.
     * @param {Object} article  { title, author, date, body, url, lang }
     * @returns {Promise<ArrayBuffer>}
     */
    async build(article) {
        const epubBuf = await this._buildEpub(article);
        const { pages } = await this._renderEpub(epubBuf);
        if (pages.length === 0) throw new Error('CREngine rendered 0 pages — EPUB may be malformed or crengine.wasm failed to load');
        const xtgList = pages.map(img => this._encodeXtg(this._dither(img)));
        return this._buildXtc(xtgList, article);
    },

    // ── EPUB builder (minimal EPUB 3.0 from article HTML) ────────────────────

    async _buildEpub(article) {
        if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded — add jszip.min.js to popup.html');
        const zip   = new JSZip();
        const title  = article.title  || 'Article';
        const author = article.author || '';
        const lang   = article.lang   || 'th';
        const esc    = s => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

        // Strip tags CREngine can't handle well
        let body = article.body || '';
        body = body.replace(/<(script|style|nav|header|footer|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, '');
        // Convert HTML-only named entities to numeric XML refs so CREngine's XML parser doesn't choke.
        // Readability content commonly contains &nbsp;, &mdash;, etc. which are invalid in standalone XML.
        body = body
            .replace(/&nbsp;/g,   '&#160;')
            .replace(/&mdash;/g,  '&#8212;')
            .replace(/&ndash;/g,  '&#8211;')
            .replace(/&hellip;/g, '&#8230;')
            .replace(/&ldquo;/g,  '&#8220;')
            .replace(/&rdquo;/g,  '&#8221;')
            .replace(/&lsquo;/g,  '&#8216;')
            .replace(/&rsquo;/g,  '&#8217;')
            .replace(/&laquo;/g,  '&#171;')
            .replace(/&raquo;/g,  '&#187;')
            .replace(/&copy;/g,   '&#169;')
            .replace(/&reg;/g,    '&#174;')
            .replace(/&trade;/g,  '&#8482;')
            .replace(/&times;/g,  '&#215;')
            .replace(/&divide;/g, '&#247;')
            .replace(/&euro;/g,   '&#8364;');

        // mimetype — must be STORED (uncompressed) and first entry per EPUB spec
        zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

        zip.folder('META-INF').file('container.xml',
`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

        const epub = zip.folder('EPUB');

        // Use HTML5 DOCTYPE (no XML prolog) — avoids strict XML parser which breaks on
        // Readability's HTML body (unclosed <br>, <img>, &nbsp; etc. are all illegal in strict XML).
        epub.file('chapter1.xhtml',
`<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${esc(lang)}">
<head><meta charset="utf-8"/><title>${esc(title)}</title></head>
<body>
<h1>${esc(title)}</h1>
${author ? `<p><em>${esc(author)}</em></p>\n` : ''}${body}
</body>
</html>`);

        epub.file('content.opf',
`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${esc(title)}</dc:title>
    <dc:creator>${esc(author)}</dc:creator>
    <dc:identifier id="uid">article-xtc-1</dc:identifier>
    <dc:language>${esc(lang)}</dc:language>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx"      href="toc.ncx"        media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="chapter1"/></spine>
</package>`);

        epub.file('toc.ncx',
`<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="article-xtc-1"/></head>
  <docTitle><text>${esc(title)}</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>${esc(title)}</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`);

        return zip.generateAsync({ type: 'arraybuffer' });
    },

    // ── Fetch WASM + font assets (no WASM execution here — done in sandbox) ──

    async _fetchAssets() {
        if (this._wasmBinary) return;
        const ext = typeof chrome !== 'undefined' ? chrome : browser;

        // Fetch all assets in parallel
        const [wasmRes, jsRes, fontRes] = await Promise.allSettled([
            fetch(ext.runtime.getURL('assets/wasm/crengine.wasm')),
            fetch(ext.runtime.getURL('src/epub/crengine.js')),
            fetch(ext.runtime.getURL('assets/fonts/NotoSansThai.ttf'))
        ]);

        if (wasmRes.status !== 'fulfilled' || !wasmRes.value.ok)
            throw new Error('crengine.wasm not found — place it at assets/wasm/crengine.wasm');
        this._wasmBinary = await wasmRes.value.arrayBuffer();

        if (jsRes.status === 'fulfilled' && jsRes.value.ok) {
            this._crengineCode = await jsRes.value.text();
        } else {
            throw new Error('src/epub/crengine.js not found — required for rendering');
        }

        if (fontRes.status === 'fulfilled' && fontRes.value.ok) {
            this._fontData = await fontRes.value.arrayBuffer();
        } else {
            console.warn('[XtcBuilder] NotoSansThai.ttf not loaded — Thai text may use fallback font');
        }
    },

    // ── Render EPUB → ImageData[] via sandboxed iframe ────────────────────────
    // crengine.js uses new Function() (Emscripten embind) which violates MV3 CSP.
    // Sandbox pages have relaxed CSP that allows eval/new Function.

    _getSandboxIframe() {
        if (this._sandboxIframe) return this._sandboxIframe;
        const ext = typeof chrome !== 'undefined' ? chrome : browser;
        const iframe = document.createElement('iframe');
        iframe.id  = 'xtc-crengine-sandbox';
        iframe.src = ext.runtime.getURL('src/sandbox/crengine_sandbox.html');
        iframe.style.cssText = 'display:none;position:absolute;width:0;height:0;border:0;';
        // Store the load promise so _renderEpub never races with a second onload assignment.
        this._sandboxLoadPromise = new Promise(resolve => { iframe.addEventListener('load', resolve, { once: true }); });
        document.body.appendChild(iframe);
        this._sandboxIframe = iframe;
        return iframe;
    },

    async _renderEpub(epubBuffer) {
        await this._fetchAssets();
        const iframe = this._getSandboxIframe();

        // Wait for iframe page to finish loading (uses stored promise — no race condition)
        await this._sandboxLoadPromise;

        const msgId = 'xtc_' + Date.now() + '_' + Math.random().toString(36).slice(2);

        const renderPromise = new Promise((resolve, reject) => {
            const handler = (ev) => {
                if (!ev.data || ev.data.id !== msgId) return;
                window.removeEventListener('message', handler);
                if (ev.data.type === 'RENDER_RESULT') {
                    this._sandboxReady = true;
                    resolve({
                        pages: ev.data.pages.map(p =>
                            new ImageData(new Uint8ClampedArray(p.buffer), p.width, p.height))
                    });
                } else {
                    reject(new Error(ev.data.error || 'Sandbox render failed'));
                }
            };
            window.addEventListener('message', handler);

            // Build message — include wasm/font/code on first call to init CREngine in sandbox
            const msg = {
                type: 'RENDER_EPUB',
                id: msgId,
                epubBuffer,
                fontSize: this.CR_FONT_SIZE,
                lineHeight: this.CR_LINE_HEIGHT,
                margin: this.CR_MARGIN,
                fontWeight: this.CR_FONT_WEIGHT,
                textAlign: this.CR_TEXT_ALIGN
            };
            const transfers = [epubBuffer];  // transfer epub buffer (zero-copy, detaches here)
            if (!this._sandboxReady) {
                // Structured-clone wasm binary and code so popup retains them for next call
                msg.crengineCode = this._crengineCode;
                msg.wasmBinary   = this._wasmBinary;
                if (this._fontData) msg.fontData = this._fontData;
            }
            iframe.contentWindow.postMessage(msg, '*', transfers);
        });

        // Safety timeout — CREngine WASM init + render can take 30-90 s on first call
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('CREngine render timed out (120 s). Try again.')), 120000));

        return Promise.race([renderPromise, timeout]);
    },

    // ── Floyd-Steinberg dithering — identical to reference encoder ────────────

    _dither(imageData) {
        const { data, width: W, height: H } = imageData;
        const gray = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) {
            const p = i * 4;
            gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        }
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const idx = y * W + x;
                const old = gray[idx];
                const nw  = old < 128 ? 0 : 255;
                gray[idx] = nw;
                const err = old - nw;
                if (x + 1 < W)             gray[idx + 1]     += err * 7 / 16;
                if (y + 1 < H) {
                    if (x > 0)             gray[idx + W - 1] += err * 3 / 16;
                                           gray[idx + W]     += err * 5 / 16;
                    if (x + 1 < W)         gray[idx + W + 1] += err * 1 / 16;
                }
            }
        }
        const out = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i++) {
            const v = Math.max(0, Math.min(255, Math.round(gray[i])));
            const p = i * 4;
            out[p] = out[p + 1] = out[p + 2] = v;
            out[p + 3] = 255;
        }
        return new ImageData(out, W, H);
    },

    // ── XTG encoder (1-bit monochrome from ImageData) ─────────────────────────

    _encodeXtg(imageData) {
        const { data, width: W, height: H } = imageData;

        const rowBytes = Math.ceil(W / 8);
        const dataSize = rowBytes * H;

        const buf  = new ArrayBuffer(22 + dataSize);
        const view = new DataView(buf);
        const u8   = new Uint8Array(buf);

        // Header: "XTG\0"
        u8[0]=0x58; u8[1]=0x54; u8[2]=0x47; u8[3]=0x00;
        view.setUint16(4,  W,        true); // width
        view.setUint16(6,  H,        true); // height
        u8[8]=0; u8[9]=0;                  // colorMode=monochrome, compression=none
        view.setUint32(10, dataSize, true); // dataSize
        // bytes 14-21: md5/reserved = 0 (already zero from ArrayBuffer)

        // Pixel data — 1 bit per pixel, MSB = leftmost
        // 0 = black, 1 = white
        for (let row = 0; row < H; row++) {
            for (let bi = 0; bi < rowBytes; bi++) {
                let byte = 0;
                for (let bit = 0; bit < 8; bit++) {
                    const col = bi * 8 + bit;
                    if (col < W) {
                        const pi = (row * W + col) * 4;
                        const gray = 0.299 * data[pi] + 0.587 * data[pi+1] + 0.114 * data[pi+2];
                        if (gray >= 128) byte |= (1 << (7 - bit)); // white = 1 (>= matches reference)
                    } else {
                        byte |= (1 << (7 - bit)); // pad white
                    }
                }
                u8[22 + row * rowBytes + bi] = byte;
            }
        }

        return buf;
    },

    // ── XTC container builder ─────────────────────────────────────────────────

    _buildXtc(xtgList, article) {
        const pc       = xtgList.length;
        const W        = this.PAGE_W, H = this.PAGE_H;
        const HDR_SZ        = 56;
        const META_SZ       = 256;
        const CHAPTER_SZ    = 96;   // X4 requires ≥1 chapter entry
        const IDX_SZ        = pc * 16;
        const chapterOff  = HDR_SZ + META_SZ;               // 312
        const indexOff    = chapterOff + CHAPTER_SZ;        // 408
        const dataStart   = indexOff + IDX_SZ;
        const totalData   = xtgList.reduce((s, b) => s + b.byteLength, 0);

        const buf  = new ArrayBuffer(dataStart + totalData);
        const view = new DataView(buf);
        const u8   = new Uint8Array(buf);

        // ── Header (56 bytes) ──
        u8[0]=0x58; u8[1]=0x54; u8[2]=0x43; u8[3]=0x00; // "XTC\0"
        view.setUint16(4,  1,  true); // version = 1
        view.setUint16(6,  pc,     true); // pageCount
        u8[8]  = 0; // readDirection: L→R
        u8[9]  = 1; // hasMetadata
        u8[10] = 0; // hasThumbnails
        u8[11] = 1; // hasChapters = 1 (X4 requires at least one chapter)
        view.setUint32(12, 1, true);               // currentPage = 1
        this._u64(view, 16, HDR_SZ);               // metadataOffset = 56
        this._u64(view, 24, indexOff);             // indexOffset = 408
        this._u64(view, 32, dataStart);            // dataOffset
        this._u64(view, 40, 0);                    // thumbOffset = 0
        this._u64(view, 48, chapterOff);           // chapterOffset = 312

        // ── Metadata (256 bytes at offset 56) ──
        const m = HDR_SZ;
        const enc = new TextEncoder();
        // Byte-safe truncation: substring(0,N) limits Unicode chars, not bytes.
        // Thai = 3 bytes/char, so truncate the encoded bytes to field size - 1 (for null).
        const rawTitle  = enc.encode(article.title  || '');
        const rawAuthor = enc.encode(article.author || '');
        const titleBytes  = rawTitle.subarray(0, Math.min(rawTitle.length,  127));
        const authorBytes = rawAuthor.subarray(0, Math.min(rawAuthor.length, 63));
        u8.set(titleBytes,  m);           u8[m + 127] = 0; // null-terminate
        u8.set(authorBytes, m + 128);     u8[m + 191] = 0; // null-terminate
        view.setUint32(m + 192, 0, true); // createTime = 0 (no timestamp)
        view.setUint16(m + 196, 1, true); // chapterCount = 1

        // ── Chapter table (96 bytes at offset 312) ──
        // X4 firmware requires hasChapters=1 with ≥1 entry to open the file.
        // IMPORTANT: limit encoded bytes to 79 max — multi-byte UTF-8 (Thai = 3 bytes/char)
        // can overflow the 80-byte title field into startPage/endPage/reserved bytes.
        const rawChTitle = enc.encode(article.title || 'Chapter 1');
        const chTitleLen = Math.min(rawChTitle.length, 79);
        u8.set(rawChTitle.subarray(0, chTitleLen), chapterOff);
        u8[chapterOff + 79] = 0;                          // null-terminate title
        view.setUint16(chapterOff + 80, 1, true);         // startPage = 1 (1-indexed)
        view.setUint16(chapterOff + 82, 1, true);         // endPage = startPage (reference behavior)

        // ── Page index table (at indexOff = 408) ──
        let off = dataStart;
        for (let i = 0; i < pc; i++) {
            const e = indexOff + i * 16;
            this._u64(view, e,      off);
            view.setUint32(e + 8,  xtgList[i].byteLength, true);
            view.setUint16(e + 12, W,                     true);
            view.setUint16(e + 14, H,                     true);
            off += xtgList[i].byteLength;
        }

        // ── Data area ──
        off = dataStart;
        for (const xtg of xtgList) {
            u8.set(new Uint8Array(xtg), off);
            off += xtg.byteLength;
        }

        return buf;
    },

    // ── Helpers ───────────────────────────────────────────────────────────────

    _u64(view, offset, val) {
        view.setUint32(offset,     (val >>> 0),                           true);
        view.setUint32(offset + 4, Math.floor(val / 0x100000000) >>> 0,   true);
    },

    generateFilename(article) {
        const safe = (s) => (s || '').replace(/[^\w\u0E00-\u0E7F\s.-]/g, '').trim();
        const title = safe(article.title).slice(0, 50) || 'article';
        const date  = article.date || new Date().toISOString().split('T')[0];
        return `${title} - ${date}.xtc`;
    }
};
