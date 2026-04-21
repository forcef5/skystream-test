(function () {
    // ─────────────────────────────────────────────────────────────────────────────
    // ThuVienCine – SkyStream Plugin
    // Port of the CloudStream 3 Kotlin plugin to JavaScript for SkyStream Gen 2.
    // Requires a Fshare VIP account. Configure via ⚙️ Domains:
    //   Set URL to: https://thuviencine.com?fshare=your_email@gmail.com:your_password
    // ─────────────────────────────────────────────────────────────────────────────

    // ── Constants ────────────────────────────────────────────────────────────────
    const FSHARE_LOGIN_API    = "https://api.fshare.vn/api/user/login";
    const FSHARE_DOWNLOAD_API = "https://api.fshare.vn/api/session/download";
    const FSHARE_FOLDER_API   = "https://api.fshare.vn/api/fileops/getFolderList";
    const FSHARE_APP_KEY      = "dMnqMMZMUnN5YpvKENaEhdQQ5jxDqddt";
    const FSHARE_USER_AGENT   = "kodivietmediaf-K58W6U";
    const TMDB_API_KEY        = "7ddf38e999a838273590dffbc2980189";
    const TMDB_BASE           = "https://api.themoviedb.org/3";
    const TMDB_IMG            = "https://image.tmdb.org/t/p";

    // ── Session state (in-memory per app session) ────────────────────────────────
    let _fshareToken   = null;
    let _fshareSession = null;
    let _fshareEmail   = null;
    let _fsharePass    = null;

    // ── Helpers: parse baseUrl for Fshare credentials ────────────────────────────
    function parseFshareCredentials() {
        try {
            const url = manifest.baseUrl;
            const idx = url.indexOf("?fshare=");
            if (idx === -1) return;
            const creds = decodeURIComponent(url.substring(idx + 8));
            const colonIdx = creds.indexOf(":");
            if (colonIdx === -1) return;
            _fshareEmail = creds.substring(0, colonIdx);
            _fsharePass  = creds.substring(colonIdx + 1);
        } catch (_) {}
    }

    function getSiteBase() {
        const url = manifest.baseUrl;
        const idx = url.indexOf("?");
        return idx === -1 ? url : url.substring(0, idx);
    }

    // ── HTTP helper ───────────────────────────────────────────────────────────────
    async function httpGet(url, headers = {}) {
        const resp = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0", ...headers }
        });
        return await resp.text();
    }

    async function httpPost(url, body, headers = {}) {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": FSHARE_USER_AGENT, ...headers },
            body: typeof body === "string" ? body : JSON.stringify(body)
        });
        return await resp.text();
    }

    function parseHtml(html) {
        return new DOMParser().parseFromString(html, "text/html");
    }

    // ── Fshare API ────────────────────────────────────────────────────────────────
    async function fshareLogin(force = false) {
        if (!force && _fshareToken && _fshareSession) return true;
        parseFshareCredentials();
        if (!_fshareEmail || !_fsharePass) return false;
        try {
            const body = JSON.stringify({
                app_key: FSHARE_APP_KEY,
                user_email: _fshareEmail,
                password: _fsharePass
            });
            const resp = JSON.parse(await httpPost(FSHARE_LOGIN_API, body));
            if (resp.token && resp.session_id) {
                _fshareToken   = resp.token;
                _fshareSession = resp.session_id;
                return true;
            }
            return false;
        } catch (_) { return false; }
    }

    async function fshareGetLink(linkCode) {
        if (!await fshareLogin()) return null;
        const fileUrl = `https://www.fshare.vn/file/${linkCode}?share=8805984`;
        const body = JSON.stringify({ zipflag: 0, url: fileUrl, password: "", token: _fshareToken });
        const hdrs = { "Cookie": `session_id=${_fshareSession}` };
        try {
            let resp = JSON.parse(await httpPost(FSHARE_DOWNLOAD_API, body, hdrs));
            if (!resp.location && resp.code === 201) {
                // Session expired – re-login once
                _fshareToken = null; _fshareSession = null;
                if (!await fshareLogin()) return null;
                const body2 = JSON.stringify({ zipflag: 0, url: fileUrl, password: "", token: _fshareToken });
                const hdrs2 = { "Cookie": `session_id=${_fshareSession}` };
                resp = JSON.parse(await httpPost(FSHARE_DOWNLOAD_API, body2, hdrs2));
            }
            return resp.location || null;
        } catch (_) { return null; }
    }

    async function fshareFolderList(folderUrl) {
        if (!await fshareLogin()) return null;
        const body = JSON.stringify({
            token: _fshareToken, url: folderUrl,
            dirOnly: 0, pageIndex: 0, limit: 10000
        });
        const hdrs = { "Cookie": `session_id=${_fshareSession}` };
        try {
            const items = JSON.parse(await httpPost(FSHARE_FOLDER_API, body, hdrs));
            return items.map(item => {
                const isFolder = item.type === "0";
                const url = isFolder
                    ? `https://www.fshare.vn/folder/${item.linkcode}`
                    : `https://www.fshare.vn/file/${item.linkcode}`;
                const gb = item.size / (1024 * 1024 * 1024);
                const sizeStr = gb >= 1 ? `${gb.toFixed(1)} GB` : `${(item.size / (1024 * 1024)).toFixed(0)} MB`;
                return { name: item.name, linkcode: item.linkcode, size: item.size, sizeStr, isFolder, url };
            }).sort((a, b) => a.name.localeCompare(b.name));
        } catch (_) { return null; }
    }

    // ── TMDB helpers ─────────────────────────────────────────────────────────────
    function cleanTitle(title) {
        return title
            .replace(/\(\d{4}\)/g, "")
            .replace(/(vietsub|thuyết minh|lồng tiếng|full hd|4k|bluray|hdrip|camrip|fshare|phần \d+|season \d+|tập \d+|[–—]|-)/gi, " ")
            .replace(/\s+/g, " ").trim();
    }

    function extractParts(title) {
        const parts = title.split(/\s*[–—]\s*|\s+-\s+/, 2);
        if (parts.length === 2) {
            return {
                vi: parts[0].replace(/\(\d{4}\)/g, "").trim(),
                en: parts[1].replace(/\(\d{4}\)/g, "").trim()
            };
        }
        return { vi: null, en: null };
    }

    function tmdbImg(path, size = "w500") {
        return path ? `${TMDB_IMG}/${size}${path}` : null;
    }

    async function searchTmdb(title, year, isSeries) {
        const { vi, en } = extractParts(title);
        const clean = cleanTitle(title);
        const endpoints = isSeries ? ["tv", "movie"] : ["movie", "tv"];
        const queries = [];
        if (en) { if (year) queries.push([en, year]); queries.push([en, null]); }
        if (vi) { if (year) queries.push([vi, year]); queries.push([vi, null]); }
        if (year) queries.push([title.trim(), year]);
        queries.push([title.trim(), null]);
        if (clean !== title.trim()) {
            if (year) queries.push([clean, year]);
            queries.push([clean, null]);
        }
        for (const ep of endpoints) {
            for (const [q, yr] of queries) {
                if (!q) continue;
                const yearParam = yr ? `&year=${yr}` : "";
                for (const lang of ["vi-VN", "en-US"]) {
                    try {
                        const url = `${TMDB_BASE}/search/${ep}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}${yearParam}&language=${lang}`;
                        const data = JSON.parse(await httpGet(url));
                        if (data.results && data.results.length > 0) {
                            return { id: data.results[0].id, type: ep };
                        }
                    } catch (_) {}
                }
            }
        }
        return null;
    }

    async function getTmdbDetails(id, type) {
        const langs = ["vi-VN", "en-US"];
        for (const lang of langs) {
            try {
                const url = `${TMDB_BASE}/${type}/${id}?api_key=${TMDB_API_KEY}&language=${lang}&include_image_language=vi,en,null&append_to_response=credits,recommendations,images`;
                const d = JSON.parse(await httpGet(url));
                if (d.overview || lang === "en-US") return d;
            } catch (_) {}
        }
        return null;
    }

    // ── Scraping helpers ──────────────────────────────────────────────────────────
    function getAttr(el, ...attrs) {
        for (const attr of attrs) {
            const val = el ? el.getAttribute(attr) : null;
            if (val && val.length > 0 && !val.startsWith("data:")) return val;
        }
        return null;
    }

    function getPosterFromImg(imgEl) {
        return imgEl ? getAttr(imgEl, "data-src", "data-lazy-src", "src") : null;
    }

    function getQuality(name) {
        if (!name) return null;
        const n = name.toLowerCase();
        if (n.includes("2160") || n.includes("4k")) return "4K";
        if (n.includes("1080")) return "1080p";
        if (n.includes("720"))  return "720p";
        if (n.includes("480"))  return "480p";
        return null;
    }

    function itemType(el, href) {
        const hasTV = el.querySelector("span.item-tv");
        if (hasTV || (href && (href.includes("/tv-series/") || href.includes("-season-") || href.includes("-phan-")))) {
            return "series";
        }
        return "movie";
    }

    function parseArticle(el) {
        const aTag = el.querySelector("a");
        const titleEl = el.querySelector(".movie-title") ||
                        el.querySelector("div.data h3 a") ||
                        el.querySelector("h3 a");
        const title = aTag?.getAttribute("title") || titleEl?.textContent?.trim() || aTag?.textContent?.trim();
        const href  = aTag?.getAttribute("href") || titleEl?.getAttribute("href");
        if (!title || !href) return null;
        const img       = el.querySelector("div.poster img, img");
        const posterUrl = getPosterFromImg(img);
        const year      = parseInt(el.querySelector("span.year, div.data span, span.movie-date")?.textContent?.trim()) || null;
        const quality   = el.querySelector("span.quality, span.item-quality")?.textContent?.trim();
        return new MultimediaItem({
            title,
            url: href,
            posterUrl,
            type: itemType(el, href),
            year,
            description: quality || undefined
        });
    }

    // ── Categories for ThuVienCine ────────────────────────────────────────────────
    const CATEGORIES = [
        ["Trending",                  "/top/page/"],
        ["Phim Lẻ",                   "/movies/page/"],
        ["Phim Bộ",                   "/tv-series/page/"],
        ["Kids",                      "/kids/page/"],
        ["Phim Hành Động",            "/phim-hanh-dong/page/"],
        ["Phim Kinh Dị",              "/phim-kinh-di/page/"],
        ["Phim Hài",                  "/phim-hai/page/"],
        ["Phim Khoa Học Viễn Tưởng",  "/phim-khoa-hoc-vien-tuong/page/"],
        ["Phim Lãng Mạn",             "/phim-lang-man/page/"],
        ["Phim Hoạt Hình",            "/phim-hoat-hinh/page/"],
        ["Phim Bí Ẩn",                "/phim-bi-an/page/"],
        ["Phim Gia Đình",             "/phim-gia-dinh/page/"],
        ["Phim Chiến Tranh",          "/phim-chien-tranh/page/"],
        ["Phim Tài Liệu",             "/phim-tai-lieu/page/"],
        ["Phim Lịch Sử",              "/phim-lich-su/page/"],
    ];

    // ── getHome ───────────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            const base = getSiteBase();
            const data = {};
            // Fetch first 3 categories in parallel for fast load, rest lazy
            const primary = CATEGORIES.slice(0, 6);
            await Promise.all(primary.map(async ([name, path]) => {
                try {
                    const html = await httpGet(`${base}${path}1`);
                    const doc  = parseHtml(html);
                    const items = Array.from(
                        doc.querySelectorAll("div.item, div.items article, div.result-item article, div#archive-content article")
                    ).map(parseArticle).filter(Boolean);
                    if (items.length > 0) data[name] = items;
                } catch (_) {}
            }));
            // Fill remaining categories
            await Promise.all(CATEGORIES.slice(6).map(async ([name, path]) => {
                try {
                    const html = await httpGet(`${base}${path}1`);
                    const doc  = parseHtml(html);
                    const items = Array.from(
                        doc.querySelectorAll("div.item, div.items article, div.result-item article, div#archive-content article")
                    ).map(parseArticle).filter(Boolean);
                    if (items.length > 0) data[name] = items;
                } catch (_) {}
            }));
            if (Object.keys(data).length === 0) {
                return cb({ success: false, errorCode: "NOT_FOUND", message: "Không tải được trang chủ" });
            }
            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.stack || String(e) });
        }
    }

    // ── search ────────────────────────────────────────────────────────────────────
    async function search(query, page, cb) {
        try {
            const base = getSiteBase();
            const html = await httpGet(`${base}/?s=${encodeURIComponent(query)}`);
            const doc  = parseHtml(html);
            const items = Array.from(
                doc.querySelectorAll("div.item, div.result-item article, div.items article, div#archive-content article")
            ).map(parseArticle).filter(Boolean);
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.stack || String(e) });
        }
    }

    // ── load ──────────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            const html = await httpGet(url, { Referer: getSiteBase() });
            const doc  = parseHtml(html);

            // Basic metadata
            const title = doc.querySelector("h1.entry-title, h1, div.sheader h1")?.textContent?.trim();
            if (!title) return cb({ success: false, errorCode: "NOT_FOUND", message: "Không tìm thấy tiêu đề" });

            const posterEl = doc.querySelector(".movie-image img, div.poster img, div.sheader div.poster img, meta[property='og:image']");
            const poster   = getPosterFromImg(posterEl) || posterEl?.getAttribute("content");

            const descEl  = doc.querySelector(".movie-description .trama, div.wp-content p, div#info div.wp-content, meta[property='og:description']");
            const description = descEl?.getAttribute("content")?.trim() || descEl?.textContent?.trim();

            const year = parseInt(doc.querySelector("a[href*='/years/'], span.date, span.year")?.textContent?.trim()) || null;

            const tags  = Array.from(doc.querySelectorAll("span[itemprop='genre'] a, div.sgeneros a, a[rel='tag']")).map(a => a.textContent.trim());
            const actors = Array.from(doc.querySelectorAll(
                "[itemprop='actor'] .name a, [itemprop='actor'] a, div.person span.name a, a[href*='/actor/']"
            )).map(a => new Actor({ name: a.textContent.trim() })).filter(a => a.name);

            // HTML recommendations
            const htmlRecs = Array.from(doc.querySelectorAll(
                "section.similar li, div.owl-item article, div.srelac article, .item-container .item"
            )).map(el => {
                const a     = el.querySelector("a");
                const img   = el.querySelector("img");
                const recTitle  = el.getAttribute("title") || img?.getAttribute("alt") || "";
                const recUrl    = a?.getAttribute("href");
                const recPoster = getPosterFromImg(img);
                if (!recTitle || !recUrl) return null;
                return new MultimediaItem({ title: recTitle, url: recUrl, posterUrl: recPoster, type: "movie" });
            }).filter(Boolean);

            // Collect Fshare links
            const fshareLinks = [];
            doc.querySelectorAll("a[href*='fshare.vn']").forEach(a => {
                const href = a.getAttribute("href");
                if (href && !fshareLinks.includes(href)) fshareLinks.push(href);
            });

            // Check download page for more Fshare links
            const dlLink = doc.querySelector("a[href*='/download?id=']")?.getAttribute("href");
            if (dlLink) {
                try {
                    const dlUrl  = dlLink.startsWith("http") ? dlLink : `${getSiteBase()}${dlLink}`;
                    const dlHtml = await httpGet(dlUrl, { Referer: url });
                    const dlDoc  = parseHtml(dlHtml);
                    dlDoc.querySelectorAll("a[href*='fshare.vn']").forEach(a => {
                        const href = a.getAttribute("href");
                        if (href && !fshareLinks.includes(href)) fshareLinks.push(href);
                    });
                } catch (_) {}
            }

            const hasFolderLinks = fshareLinks.some(l => l.includes("/folder/"));
            const isSeries = url.includes("/tv-series/") ||
                tags.some(t => t.toLowerCase().includes("phim bộ")) ||
                doc.querySelector("div.episodios li, ul.episodios li, div.se-c") !== null ||
                hasFolderLinks || fshareLinks.length > 1;

            // ── TMDB enrichment ──────────────────────────────────────────────────
            let tmdbPoster = null, tmdbBanner = null, tmdbPlot = null;
            let tmdbActors = null, tmdbTags = null, tmdbRecs = null, tmdbYear = null, tmdbScore = null;
            try {
                const tmdb = await searchTmdb(title, year, isSeries);
                if (tmdb) {
                    const d = await getTmdbDetails(tmdb.id, tmdb.type);
                    if (d) {
                        const viPoster   = d.images?.posters?.find(p => p.iso_639_1 === "vi")?.file_path;
                        const viBackdrop = d.images?.backdrops?.find(p => p.iso_639_1 === "vi")?.file_path;
                        tmdbPoster  = tmdbImg(viPoster  || d.poster_path,   "w500");
                        tmdbBanner  = tmdbImg(viBackdrop || d.backdrop_path, "original");
                        tmdbPlot    = d.overview || null;
                        tmdbScore   = d.vote_average ? Math.round(d.vote_average * 10) / 10 : null;
                        tmdbYear    = parseInt((d.release_date || d.first_air_date || "").slice(0, 4)) || null;
                        tmdbTags    = d.genres?.map(g => g.name);
                        tmdbActors  = d.credits?.cast?.slice(0, 10).map(m =>
                            new Actor({ name: m.name, role: m.character, image: tmdbImg(m.profile_path, "w185") })
                        );
                        tmdbRecs = d.recommendations?.results?.slice(0, 10).map(r => {
                            const rTitle = r.title || r.name;
                            if (!rTitle) return null;
                            return new MultimediaItem({
                                title: rTitle, type: "movie",
                                url: `${getSiteBase()}/?s=${encodeURIComponent(rTitle)}`,
                                posterUrl: tmdbImg(r.poster_path, "w220_and_h330_face")
                            });
                        }).filter(Boolean);
                    }
                }
            } catch (_) {}

            // Merge TMDB + site data
            const finalPoster  = tmdbPoster  || poster  || "";
            const finalBanner  = tmdbBanner  || finalPoster;
            const finalPlot    = tmdbPlot    || description;
            const finalTags    = (tmdbTags && tmdbTags.length > 0) ? tmdbTags : tags;
            const finalActors  = (tmdbActors && tmdbActors.length > 0) ? tmdbActors : actors;
            const finalRecs    = (tmdbRecs   && tmdbRecs.length > 0)   ? tmdbRecs   : htmlRecs;
            const finalYear    = tmdbYear    || year;

            // ── Build episodes / movie data ───────────────────────────────────────
            if (isSeries) {
                const episodes = [];

                // Try inline episode list first
                const epEls = doc.querySelectorAll("div.episodios li, ul.episodios li");
                if (epEls.length > 0) {
                    epEls.forEach((ep, idx) => {
                        const epTitle = ep.querySelector("a")?.textContent?.trim() || `Tập ${idx + 1}`;
                        const epLink  = ep.querySelector("a")?.getAttribute("href") || url;
                        episodes.push(new Episode({ name: epTitle, url: epLink, season: 1, episode: idx + 1 }));
                    });
                } else {
                    // Process Fshare folder / file links to build episode list
                    const folderLinks = fshareLinks.filter(l => l.includes("/folder/"));
                    const fileLinks   = fshareLinks.filter(l => !l.includes("/folder/"));
                    let seasonIndex = 1;

                    for (const rootFolder of folderLinks) {
                        try {
                            const items = await fshareFolderList(rootFolder);
                            if (!items) throw new Error("api_fail");

                            const subFolders = items.filter(i => i.isFolder);
                            const rootFiles  = items.filter(i => !i.isFolder);

                            if (subFolders.length > 0) {
                                // Fetch sub-folder contents in parallel
                                const sfResults = await Promise.all(subFolders.map(async (sf, sfIdx) => {
                                    const files = await fshareFolderList(sf.url).catch(() => null);
                                    return { sfIdx, sf, files: files?.filter(f => !f.isFolder) };
                                }));
                                sfResults.sort((a, b) => a.sfIdx - b.sfIdx).forEach(({ sf, files }) => {
                                    const sNum = seasonIndex++;
                                    (files || []).sort((a, b) => a.name.localeCompare(b.name)).forEach((file, idx) => {
                                        episodes.push(new Episode({
                                            name: file.name, season: sNum, episode: idx + 1,
                                            url: `${file.url}|||${file.sizeStr}|||${file.name}`,
                                            description: `(${file.sizeStr}) - ${file.name}`,
                                            posterUrl: finalPoster
                                        }));
                                    });
                                    if (!files || files.length === 0) {
                                        episodes.push(new Episode({
                                            name: `📁 ${sf.name}`, season: sNum, episode: 1,
                                            url: sf.url, posterUrl: finalPoster
                                        }));
                                    }
                                });
                                if (rootFiles.length > 0) {
                                    rootFiles.sort((a, b) => a.name.localeCompare(b.name)).forEach((file, idx) => {
                                        episodes.push(new Episode({
                                            name: file.name, season: seasonIndex, episode: idx + 1,
                                            url: `${file.url}|||${file.sizeStr}|||${file.name}`,
                                            description: `(${file.sizeStr}) - ${file.name}`,
                                            posterUrl: finalPoster
                                        }));
                                    });
                                    seasonIndex++;
                                }
                            } else {
                                // No sub-folders – flat file list
                                rootFiles.sort((a, b) => a.name.localeCompare(b.name)).forEach((file, idx) => {
                                    episodes.push(new Episode({
                                        name: file.name, season: seasonIndex, episode: idx + 1,
                                        url: `${file.url}|||${file.sizeStr}|||${file.name}`,
                                        description: `(${file.sizeStr}) - ${file.name}`,
                                        posterUrl: finalPoster
                                    }));
                                });
                                seasonIndex++;
                            }
                        } catch (_) {
                            episodes.push(new Episode({
                                name: `📁 Phần ${seasonIndex}`, season: seasonIndex, episode: 1,
                                url: rootFolder, posterUrl: finalPoster
                            }));
                            seasonIndex++;
                        }
                    }

                    // Standalone file links
                    fileLinks.forEach((link, idx) => {
                        const linkName = `Link ${idx + 1}`;
                        episodes.push(new Episode({
                            name: linkName, season: folderLinks.length > 0 ? seasonIndex : 1, episode: idx + 1,
                            url: link, posterUrl: finalPoster, description: linkName
                        }));
                    });
                }

                const item = new MultimediaItem({
                    title, url, type: "series",
                    posterUrl: finalPoster, bannerUrl: finalBanner,
                    description: finalPlot, year: finalYear,
                    score: tmdbScore, tags: finalTags,
                    cast: finalActors, recommendations: finalRecs,
                    episodes
                });
                cb({ success: true, data: item });

            } else {
                // Movie – collect Fshare file references
                const fshareRefs = [];
                doc.querySelectorAll("a[href*='fshare.vn']").forEach(a => {
                    const href = a.getAttribute("href");
                    if (href && href.includes("fshare.vn") && !fshareRefs.some(r => r.url === href)) {
                        const name = (a.getAttribute("title") || a.textContent || "").trim() || href.split("/").pop();
                        fshareRefs.push({ url: href, name });
                    }
                });
                // Encode as |||‑separated "url|||name" entries stored in item.url for loadStreams
                const dataUrl = fshareRefs.length > 0
                    ? `__FSHARE__${JSON.stringify(fshareRefs)}`
                    : url;

                const item = new MultimediaItem({
                    title, url: dataUrl, type: "movie",
                    posterUrl: finalPoster, bannerUrl: finalBanner,
                    description: finalPlot, year: finalYear,
                    score: tmdbScore, tags: finalTags,
                    cast: finalActors, recommendations: finalRecs
                });
                cb({ success: true, data: item });
            }
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.stack || String(e) });
        }
    }

    // ── loadStreams ───────────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            const streams = [];

            // Episode URL encoded as "fshare_url|||size|||name"
            if (url.includes("|||")) {
                const parts    = url.split("|||");
                const fUrl     = parts[0];
                const sizeStr  = parts[1] || "";
                const fileName = parts[2] || "";
                const linkCode = fUrl.split("/").pop();
                if (fUrl.includes("/folder/")) {
                    const files = await fshareFolderList(fUrl);
                    if (files) {
                        await Promise.all(files.filter(f => !f.isFolder).map(async file => {
                            const direct = await fshareGetLink(file.linkcode);
                            if (direct) {
                                streams.push(new StreamResult({
                                    url: direct, source: `(${file.sizeStr}) ${file.name}`,
                                    quality: getQuality(file.name),
                                    headers: { Referer: "https://www.fshare.vn/" }
                                }));
                            }
                        }));
                    }
                } else {
                    const direct = await fshareGetLink(linkCode);
                    if (direct) {
                        const label = sizeStr && fileName ? `(${sizeStr}) ${fileName}` : (fileName || `File ${linkCode}`);
                        streams.push(new StreamResult({
                            url: direct, source: label,
                            quality: getQuality(fileName || fUrl),
                            headers: { Referer: "https://www.fshare.vn/" }
                        }));
                    }
                }

            } else if (url.startsWith("__FSHARE__")) {
                // Movie multi-file
                const refs = JSON.parse(url.slice("__FSHARE__".length));
                await Promise.all(refs.map(async ({ url: fUrl, name }) => {
                    const linkCode = fUrl.split("/").pop();
                    const direct = await fshareGetLink(linkCode);
                    if (direct) {
                        streams.push(new StreamResult({
                            url: direct, source: name || linkCode,
                            quality: getQuality(name || fUrl),
                            headers: { Referer: "https://www.fshare.vn/" }
                        }));
                    }
                }));

            } else if (url.includes("fshare.vn")) {
                // Single fshare URL
                const linkCode = url.split("/").pop().split("?")[0];
                const direct = await fshareGetLink(linkCode);
                if (direct) {
                    streams.push(new StreamResult({
                        url: direct, source: "Fshare Direct",
                        headers: { Referer: "https://www.fshare.vn/" }
                    }));
                }

            } else {
                // It's a page URL (e.g. episode page) – scrape Fshare links from it
                try {
                    const html = await httpGet(url, { Referer: getSiteBase() });
                    const doc  = parseHtml(html);
                    const links = Array.from(doc.querySelectorAll("a[href*='fshare.vn']"))
                        .map(a => a.getAttribute("href")).filter(Boolean);
                    await Promise.all(links.map(async (fUrl, idx) => {
                        const linkCode = fUrl.split("/").pop().split("?")[0];
                        const direct = await fshareGetLink(linkCode);
                        if (direct) {
                            streams.push(new StreamResult({
                                url: direct, source: `Stream ${idx + 1}`,
                                headers: { Referer: "https://www.fshare.vn/" }
                            }));
                        }
                    }));
                } catch (_) {}
            }

            if (streams.length === 0) {
                return cb({
                    success: false, errorCode: "NOT_FOUND",
                    message: "Không tìm thấy stream. Hãy kiểm tra tài khoản Fshare VIP trong ⚙️ Domains."
                });
            }
            cb({ success: true, data: streams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.stack || String(e) });
        }
    }

    // ── Export ────────────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams  = loadStreams;
})();
