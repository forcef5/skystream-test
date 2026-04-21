// ThuVienCine – SkyStream Plugin
// Fshare: set domain to https://thuviencine.com?fshare=email:password

const FSHARE_LOGIN = "https://api.fshare.vn/api/user/login";
const FSHARE_DOWNLOAD = "https://api.fshare.vn/api/session/download";
const FSHARE_FOLDER = "https://api.fshare.vn/api/fileops/getFolderList";
const FSHARE_KEY = "dMnqMMZMUnN5YpvKENaEhdQQ5jxDqddt";
const FSHARE_UA = "kodivietmediaf-K58W6U";
const TMDB_KEY = "7ddf38e999a838273590dffbc2980189";
const TMDB = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p";

let _fToken = null, _fSession = null, _fEmail = null, _fPass = null;

function parseCreds() {
    try {
        const u = manifest.baseUrl, i = u.indexOf("?fshare=");
        if (i === -1) return;
        const c = decodeURIComponent(u.substring(i + 8)), ci = c.indexOf(":");
        if (ci === -1) return;
        _fEmail = c.substring(0, ci); _fPass = c.substring(ci + 1);
    } catch (_) { }
}
function base() {
    const u = manifest.baseUrl, i = u.indexOf("?");
    return i === -1 ? u : u.substring(0, i);
}

// HTTP helpers using SkyStream's native bridge
async function httpGet(url, hdrs) {
    const r = await http_get(url, hdrs || {});
    return typeof r === 'object' ? (r.body || '') : String(r || '');
}
async function httpPostJson(url, body, hdrs) {
    const allHdrs = { "Content-Type": "application/json", "User-Agent": FSHARE_UA, ...(hdrs || {}) };
    const r = await http_post(url, allHdrs, typeof body === 'string' ? body : JSON.stringify(body));
    return typeof r === 'object' ? (r.body || '') : String(r || '');
}

// Fshare
async function fshareLogin(force) {
    if (!force && _fToken && _fSession) return true;
    parseCreds();
    if (!_fEmail || !_fPass) return false;
    try {
        const r = JSON.parse(await httpPostJson(FSHARE_LOGIN, { app_key: FSHARE_KEY, user_email: _fEmail, password: _fPass }));
        if (r.token && r.session_id) { _fToken = r.token; _fSession = r.session_id; return true; }
    } catch (_) { }
    return false;
}
async function fshareGetLink(code) {
    if (!await fshareLogin()) return null;
    const fUrl = "https://www.fshare.vn/file/" + code;
    try {
        let r = JSON.parse(await httpPostJson(FSHARE_DOWNLOAD, { zipflag: 0, url: fUrl, password: "", token: _fToken }, { Cookie: "session_id=" + _fSession }));
        if (!r.location && r.code === 201) {
            _fToken = null; _fSession = null;
            if (!await fshareLogin()) return null;
            r = JSON.parse(await httpPostJson(FSHARE_DOWNLOAD, { zipflag: 0, url: fUrl, password: "", token: _fToken }, { Cookie: "session_id=" + _fSession }));
        }
        return r.location || null;
    } catch (_) { return null; }
}
async function fshareFolderList(folderUrl) {
    if (!await fshareLogin()) return null;
    try {
        const items = JSON.parse(await httpPostJson(FSHARE_FOLDER, { token: _fToken, url: folderUrl, dirOnly: 0, pageIndex: 0, limit: 10000 }, { Cookie: "session_id=" + _fSession }));
        return items.map(item => {
            const isF = item.type === "0";
            const gb = item.size / (1024 * 1024 * 1024);
            return { name: item.name, linkcode: item.linkcode, size: item.size, sizeStr: gb >= 1 ? gb.toFixed(1) + " GB" : (item.size / (1024 * 1024)).toFixed(0) + " MB", isFolder: isF, url: isF ? "https://www.fshare.vn/folder/" + item.linkcode : "https://www.fshare.vn/file/" + item.linkcode };
        }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (_) { return null; }
}

// TMDB
function tImg(p, s) { return p ? TMDB_IMG + "/" + (s || "w500") + p : null; }
function cleanT(t) { return t.replace(/\(\d{4}\)/g, "").replace(/(vietsub|thuyết minh|lồng tiếng|full hd|4k|bluray|fshare|phần \d+|season \d+|[–—])/gi, " ").replace(/\s+/g, " ").trim(); }
async function searchTmdb(title, year, isSeries) {
    const parts = title.split(/\s*[–—]\s*/);
    const qs = parts.length >= 2 ? [parts[1], parts[0], title] : [title, cleanT(title)];
    const types = isSeries ? ["tv", "movie"] : ["movie", "tv"];
    for (const type of types)
        for (const q of qs) {
            if (!q || q.length < 2) continue;
            for (const lang of ["vi-VN", "en-US"]) {
                try {
                    const yr = year ? "&year=" + year : "";
                    const d = JSON.parse(await httpGet(TMDB + "/search/" + type + "?api_key=" + TMDB_KEY + "&query=" + encodeURIComponent(q) + yr + "&language=" + lang));
                    if (d.results && d.results.length > 0) return { id: d.results[0].id, type };
                } catch (_) { }
            }
        }
    return null;
}
async function getTmdbDetails(id, type) {
    for (const lang of ["vi-VN", "en-US"]) {
        try {
            const d = JSON.parse(await httpGet(TMDB + "/" + type + "/" + id + "?api_key=" + TMDB_KEY + "&language=" + lang + "&append_to_response=credits,recommendations,images&include_image_language=vi,en,null"));
            if (d.overview || lang === "en-US") return d;
        } catch (_) { }
    }
    return null;
}

// Parse listing page using parseHtml (native DOM bridge)
// ThuVienCine uses <a title="..." href="/phim-..."> with nested <img>, NOT <article> tags
async function parseListPage(html) {
    const items = [];
    try {
        const doc = await parseHtml(html);
        // Try article tags first (fallback), then a[title] tags (thuviencine's actual structure)
        let elements = doc.querySelectorAll("article");
        if (!elements || elements.length === 0) {
            elements = doc.querySelectorAll("a[title]");
        }
        for (const el of elements) {
            let href, title, img;
            if (el.tagName && el.tagName.toLowerCase() === 'a') {
                // Direct <a> tag structure (thuviencine.com)
                href = el.getAttribute("href");
                title = el.getAttribute("title") || el.textContent.trim();
                img = el.querySelector("img");
            } else {
                // <article> tag structure (fallback)
                const a = el.querySelector("h3 a") || el.querySelector("a[title]") || el.querySelector("a");
                if (!a) continue;
                href = a.getAttribute("href");
                title = a.getAttribute("title") || a.textContent.trim();
                img = el.querySelector("img");
            }
            if (!href || !title) continue;
            if (!href.includes("/phim-") && !href.includes("/movies/") && !href.includes("/tv-series/")) continue;
            const poster = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src")) : null;
            const yearM = title.match(/\b(19|20)\d{2}\b/);
            const type = (href.includes("/tv-series/") || href.includes("-season-")) ? "series" : "movie";
            items.push(new MultimediaItem({ title: title.trim(), url: href, posterUrl: poster || "", type, year: yearM ? parseInt(yearM[0]) : undefined }));
        }
    } catch (e) { console.error("parseListPage: " + e); }
    return items;
}

// Categories
const CATS = [
    ["Trending", "/top/page/"], ["Phim Lẻ", "/movies/page/"], ["Phim Bộ", "/tv-series/page/"],
    ["Kids", "/kids/page/"], ["Hành Động", "/phim-hanh-dong/page/"], ["Kinh Dị", "/phim-kinh-di/page/"],
    ["Hài", "/phim-hai/page/"], ["Viễn Tưởng", "/phim-khoa-hoc-vien-tuong/page/"],
    ["Lãng Mạn", "/phim-lang-man/page/"], ["Hoạt Hình", "/phim-hoat-hinh/page/"],
];

async function getHome(cb) {
    try {
        const b = base(), data = {};
        await Promise.all(CATS.map(async ([name, path]) => {
            try {
                const html = await httpGet(b + path + "1");
                const items = await parseListPage(html);
                if (items.length > 0) data[name] = items;
            } catch (_) { }
        }));
        if (Object.keys(data).length === 0) return cb({ success: false, errorCode: "NOT_FOUND", message: "Không tải được trang chủ" });
        cb({ success: true, data });
    } catch (e) { cb({ success: false, errorCode: "PARSE_ERROR", message: e.stack || String(e) }); }
}

async function search(query, page, cb) {
    try {
        const html = await httpGet(base() + "/?s=" + encodeURIComponent(query));
        const items = await parseListPage(html);
        cb({ success: true, data: items });
    } catch (e) { cb({ success: false, errorCode: "SEARCH_ERROR", message: e.stack || String(e) }); }
}

async function load(url, cb) {
    try {
        const html = await httpGet(url, { Referer: base() });
        const doc = await parseHtml(html);

        // Title
        const h1 = doc.querySelector("h1");
        const title = h1 ? h1.textContent.trim() : "";
        if (!title) return cb({ success: false, errorCode: "NOT_FOUND", message: "Không tìm thấy tiêu đề" });

        // Poster
        const metaImg = doc.querySelector("meta[property='og:image']");
        const posterDiv = doc.querySelector(".poster img") || doc.querySelector("img.poster");
        const poster = (metaImg ? metaImg.getAttribute("content") : null) || (posterDiv ? (posterDiv.getAttribute("data-src") || posterDiv.getAttribute("src")) : null) || "";

        // Description
        const metaDesc = doc.querySelector("meta[property='og:description']");
        const description = metaDesc ? metaDesc.getAttribute("content") : "";

        // Year
        const yearM = title.match(/\b(19|20)\d{2}\b/);
        const year = yearM ? parseInt(yearM[0]) : null;

        // Tags
        const tags = [];
        const genreLinks = doc.querySelectorAll("a[href*='genre'], a[href*='the-loai']");
        for (const g of genreLinks) { const t = g.textContent.trim(); if (t) tags.push(t); }

        // Fshare links
        const fshareLinks = [];
        const allLinks = doc.querySelectorAll("a[href*='fshare.vn']");
        for (const l of allLinks) {
            const h = l.getAttribute("href");
            if (h && !fshareLinks.includes(h)) fshareLinks.push(h);
        }

        // Check download page
        if (fshareLinks.length === 0) {
            const dlLink = doc.querySelector("a[href*='/download?id=']");
            if (dlLink) {
                try {
                    const dlUrl = dlLink.getAttribute("href");
                    const fullDl = dlUrl.startsWith("http") ? dlUrl : base() + dlUrl;
                    const dlHtml = await httpGet(fullDl, { Referer: url });
                    const dlDoc = await parseHtml(dlHtml);
                    const dlFs = dlDoc.querySelectorAll("a[href*='fshare.vn']");
                    for (const l of dlFs) { const h = l.getAttribute("href"); if (h && !fshareLinks.includes(h)) fshareLinks.push(h); }
                } catch (_) { }
            }
        }

        const hasFolders = fshareLinks.some(l => l.includes("/folder/"));
        const isSeries = url.includes("/tv-series/") || hasFolders || fshareLinks.length > 1
            || doc.querySelector(".episodios") != null || tags.some(t => t.toLowerCase().includes("phim bộ"));

        // TMDB
        let tmdbP = null, tmdbB = null, tmdbPlot = null, tmdbActors = null, tmdbTags = null, tmdbRecs = null, tmdbYear = null, tmdbScore = null;
        try {
            const t = await searchTmdb(title, year, isSeries);
            if (t) {
                const d = await getTmdbDetails(t.id, t.type);
                if (d) {
                    tmdbP = tImg(d.poster_path); tmdbB = tImg(d.backdrop_path, "original");
                    tmdbPlot = d.overview; tmdbScore = d.vote_average ? Math.round(d.vote_average * 10) / 10 : null;
                    tmdbYear = parseInt((d.release_date || d.first_air_date || "").slice(0, 4)) || null;
                    tmdbTags = d.genres ? d.genres.map(g => g.name) : null;
                    tmdbActors = d.credits && d.credits.cast ? d.credits.cast.slice(0, 10).map(m => new Actor({ name: m.name, role: m.character, image: tImg(m.profile_path, "w185") })) : null;
                    tmdbRecs = d.recommendations && d.recommendations.results ? d.recommendations.results.slice(0, 10).map(r => { const n = r.title || r.name; return n ? new MultimediaItem({ title: n, type: "movie", url: base() + "/?s=" + encodeURIComponent(n), posterUrl: tImg(r.poster_path, "w220_and_h330_face") || "" }) : null; }).filter(Boolean) : null;
                }
            }
        } catch (_) { }

        const fP = tmdbP || poster, fB = tmdbB || fP, fPlot = tmdbPlot || description;
        const fTags = (tmdbTags && tmdbTags.length) ? tmdbTags : tags;
        const fActors = (tmdbActors && tmdbActors.length) ? tmdbActors : [];
        const fRecs = (tmdbRecs && tmdbRecs.length) ? tmdbRecs : [];
        const fYear = tmdbYear || year;

        if (isSeries) {
            const episodes = [];
            const folderLinks = fshareLinks.filter(l => l.includes("/folder/"));
            const fileLinks = fshareLinks.filter(l => !l.includes("/folder/"));
            let si = 1;
            for (const rootFolder of folderLinks) {
                try {
                    const items = await fshareFolderList(rootFolder);
                    if (!items) { episodes.push(new Episode({ name: "📁 Phần " + si, season: si++, episode: 1, url: rootFolder })); continue; }
                    const files = items.filter(i => !i.isFolder);
                    files.forEach((f, i) => {
                        episodes.push(new Episode({ name: f.name, season: si, episode: i + 1, url: f.url + "|||" + f.sizeStr + "|||" + f.name, description: "(" + f.sizeStr + ") - " + f.name }));
                    });
                    if (files.length) si++;
                } catch (_) { episodes.push(new Episode({ name: "📁 Phần " + si, season: si++, episode: 1, url: rootFolder })); }
            }
            fileLinks.forEach((link, idx) => {
                episodes.push(new Episode({ name: "Link " + (idx + 1), season: folderLinks.length ? si : 1, episode: idx + 1, url: link }));
            });
            cb({ success: true, data: new MultimediaItem({ title, url, type: "series", posterUrl: fP, bannerUrl: fB, description: fPlot, year: fYear, score: tmdbScore, tags: fTags, cast: fActors, recommendations: fRecs, episodes }) });
        } else {
            const refs = fshareLinks.map((fl, i) => ({ url: fl, name: "Link " + (i + 1) }));
            const dataUrl = refs.length > 0 ? "__FSHARE__" + JSON.stringify(refs) : url;
            cb({ success: true, data: new MultimediaItem({ title, url: dataUrl, type: "movie", posterUrl: fP, bannerUrl: fB, description: fPlot, year: fYear, score: tmdbScore, tags: fTags, cast: fActors, recommendations: fRecs }) });
        }
    } catch (e) { cb({ success: false, errorCode: "LOAD_ERROR", message: e.stack || String(e) }); }
}

function getQuality(n) { if (!n) return null; n = n.toLowerCase(); if (n.includes("2160") || n.includes("4k")) return "4K"; if (n.includes("1080")) return "1080p"; if (n.includes("720")) return "720p"; return null; }

async function loadStreams(url, cb) {
    try {
        const streams = [];
        if (url.includes("|||")) {
            const p = url.split("|||"), fUrl = p[0], sz = p[1] || "", fn = p[2] || "";
            if (fUrl.includes("/folder/")) {
                const files = await fshareFolderList(fUrl);
                if (files) await Promise.all(files.filter(f => !f.isFolder).map(async file => {
                    const d = await fshareGetLink(file.linkcode);
                    if (d) streams.push(new StreamResult({ url: d, source: "(" + file.sizeStr + ") " + file.name, quality: getQuality(file.name), headers: { Referer: "https://www.fshare.vn/" } }));
                }));
            } else {
                const lc = fUrl.split("/").pop().split("?")[0];
                const d = await fshareGetLink(lc);
                if (d) streams.push(new StreamResult({ url: d, source: sz && fn ? "(" + sz + ") " + fn : fn || lc, quality: getQuality(fn || fUrl), headers: { Referer: "https://www.fshare.vn/" } }));
            }
        } else if (url.startsWith("__FSHARE__")) {
            const refs = JSON.parse(url.slice(10));
            await Promise.all(refs.map(async ({ url: fUrl, name }) => {
                const lc = fUrl.split("/").pop().split("?")[0];
                const d = await fshareGetLink(lc);
                if (d) streams.push(new StreamResult({ url: d, source: name || lc, quality: getQuality(name || fUrl), headers: { Referer: "https://www.fshare.vn/" } }));
            }));
        } else if (url.includes("fshare.vn")) {
            const lc = url.split("/").pop().split("?")[0];
            const d = await fshareGetLink(lc);
            if (d) streams.push(new StreamResult({ url: d, source: "Fshare Direct", headers: { Referer: "https://www.fshare.vn/" } }));
        } else {
            const html = await httpGet(url, { Referer: base() });
            const doc = await parseHtml(html);
            const links = doc.querySelectorAll("a[href*='fshare.vn']");
            const unique = [];
            for (const l of links) { const h = l.getAttribute("href"); if (h && !unique.includes(h)) unique.push(h); }
            await Promise.all(unique.map(async (fUrl, idx) => {
                const lc = fUrl.split("/").pop().split("?")[0];
                const d = await fshareGetLink(lc);
                if (d) streams.push(new StreamResult({ url: d, source: "Stream " + (idx + 1), headers: { Referer: "https://www.fshare.vn/" } }));
            }));
        }
        if (streams.length === 0) return cb({ success: false, errorCode: "NOT_FOUND", message: "Không tìm thấy stream. Kiểm tra Fshare VIP: ⚙️ Domains → https://thuviencine.com?fshare=email:password" });
        cb({ success: true, data: streams });
    } catch (e) { cb({ success: false, errorCode: "STREAM_ERROR", message: e.stack || String(e) }); }
}

globalThis.getHome = getHome;
globalThis.search = search;
globalThis.load = load;
globalThis.loadStreams = loadStreams;
