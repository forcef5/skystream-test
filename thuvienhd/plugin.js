(function () {
    // ─────────────────────────────────────────────────────────────────────────────
    // ThuVienHD – SkyStream Plugin
    // Port of the CloudStream 3 Kotlin plugin to JavaScript for SkyStream Gen 2.
    // Requires a Fshare VIP account. Configure via ⚙️ Domains:
    //   Set URL to: https://thuvienhd.top?fshare=your_email@gmail.com:your_password
    // ─────────────────────────────────────────────────────────────────────────────

    const FSHARE_LOGIN_API = "https://api.fshare.vn/api/user/login";
    const FSHARE_DOWNLOAD_API = "https://api.fshare.vn/api/session/download";
    const FSHARE_FOLDER_API = "https://api.fshare.vn/api/fileops/getFolderList";
    const FSHARE_APP_KEY = "dMnqMMZMUnN5YpvKENaEhdQQ5jxDqddt";
    const FSHARE_USER_AGENT = "kodivietmediaf-K58W6U";
    const TMDB_API_KEY = "7ddf38e999a838273590dffbc2980189";
    const TMDB_BASE = "https://api.themoviedb.org/3";
    const TMDB_IMG = "https://image.tmdb.org/t/p";

    let _fshareToken = null;
    let _fshareSession = null;
    let _fshareEmail = null;
    let _fsharePass = null;

    // ── Credential & URL helpers ─────────────────────────────────────────────────
    function parseFshareCredentials() {
        try {
            const url = manifest.baseUrl;
            const idx = url.indexOf("?fshare=");
            if (idx === -1) return;
            const creds = decodeURIComponent(url.substring(idx + 8));
            const colon = creds.indexOf(":");
            if (colon === -1) return;
            _fshareEmail = creds.substring(0, colon);
            _fsharePass = creds.substring(colon + 1);
        } catch (_) { }
    }

    function getSiteBase() {
        const url = manifest.baseUrl;
        const idx = url.indexOf("?");
        return idx === -1 ? url : url.substring(0, idx);
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────────────
    async function httpGet(url, headers = {}) {
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", ...headers } });
        return await r.text();
    }

    async function httpPost(url, body, headers = {}) {
        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": FSHARE_USER_AGENT, ...headers },
            body: typeof body === "string" ? body : JSON.stringify(body)
        });
        return await r.text();
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
            const body = JSON.stringify({ app_key: FSHARE_APP_KEY, user_email: _fshareEmail, password: _fsharePass });
            const resp = JSON.parse(await httpPost(FSHARE_LOGIN_API, body));
            if (resp.token && resp.session_id) {
                _fshareToken = resp.token;
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
        const hdrs = { Cookie: `session_id=${_fshareSession}` };
        try {
            let resp = JSON.parse(await httpPost(FSHARE_DOWNLOAD_API, body, hdrs));
            if (!resp.location && resp.code === 201) {
                _fshareToken = null; _fshareSession = null;
                if (!await fshareLogin()) return null;
                const body2 = JSON.stringify({ zipflag: 0, url: fileUrl, password: "", token: _fshareToken });
                const hdrs2 = { Cookie: `session_id=${_fshareSession}` };
                resp = JSON.parse(await httpPost(FSHARE_DOWNLOAD_API, body2, hdrs2));
            }
            return resp.location || null;
        } catch (_) { return null; }
    }

    async function fshareFolderList(folderUrl) {
        if (!await fshareLogin()) return null;
        const body = JSON.stringify({ token: _fshareToken, url: folderUrl, dirOnly: 0, pageIndex: 0, limit: 10000 });
        const hdrs = { Cookie: `session_id=${_fshareSession}` };
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
            return { vi: parts[0].replace(/\(\d{4}\)/g, "").trim(), en: parts[1].replace(/\(\d{4}\)/g, "").trim() };
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
        if (clean !== title.trim()) { if (year) queries.push([clean, year]); queries.push([clean, null]); }
        for (const ep of endpoints) {
            for (const [q, yr] of queries) {
                if (!q) continue;
                const yearParam = yr ? `&year=${yr}` : "";
                for (const lang of ["vi-VN", "en-US"]) {
                    try {
                        const url = `${TMDB_BASE}/search/${ep}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}${yearParam}&language=${lang}`;
                        const d = JSON.parse(await httpGet(url));
                        if (d.results && d.results.length > 0) return { id: d.results[0].id, type: ep };
                    } catch (_) { }
                }
            }
        }
        return null;
    }

    async function getTmdbDetails(id, type) {
        for (const lang of ["vi-VN", "en-US"]) {
            try {
                const url = `${TMDB_BASE}/${type}/${id}?api_key=${TMDB_API_KEY}&language=${lang}&include_image_language=vi,en,null&append_to_response=credits,recommendations,images`;
                const d = JSON.parse(await httpGet(url));
                if (d.overview || lang === "en-US") return d;
            } catch (_) { }
        }
        return null;
    }

    // ── Scraping helpers ──────────────────────────────────────────────────────────
    function getPosterFromImg(imgEl) {
        if (!imgEl) return null;
        for (const attr of ["data-src", "data-lazy-src", "src"]) {
            const v = imgEl.getAttribute(attr);
            if (v && v.length > 0 && !v.startsWith("data:")) return v;
        }
        return null;
    }

    function getQuality(name) {
        if (!name) return null;
        const n = name.toLowerCase();
        if (n.includes("2160") || n.includes("4k")) return "4K";
        if (n.includes("1080")) return "1080p";
        if (n.includes("720")) return "720p";
        if (n.includes("480")) return "480p";
        return null;
    }

    function parseArticle(el) {
        const titleEl = el.querySelector("div.data h3 a, h3 a");
        const title = titleEl?.textContent?.trim();
        const href = titleEl?.getAttribute("href");
        if (!title || !href) return null;
        const img = el.querySelector("div.poster img, img");
        const posterUrl = getPosterFromImg(img);
        const year = parseInt(el.querySelector("div.data span, span.year")?.textContent?.trim()) || null;
        const quality = el.querySelector("span.quality")?.textContent?.trim();
        return new MultimediaItem({ title, url: href, posterUrl, type: "movie", year, description: quality || undefined });
    }

    // ── Categories for ThuVienHD ─────────────────────────────────────────────────
    const CATEGORIES = [
        ["Trending", "/trending/page/"],
        ["Phim Mới Nhất", "/recent/page/"],
        ["Phim Lẻ", "/genre/phim-le/page/"],
        ["Phim Bộ", "/genre/series/page/"],
        ["Thuyết Minh", "/genre/thuyet-minh-tieng-viet/page/"],
        ["Lồng Tiếng", "/genre/long-tieng-tieng-viet/page/"],
        ["Hành Động", "/genre/action/page/"],
        ["Kinh Dị", "/genre/horror/page/"],
        ["Hài", "/genre/comedy/page/"],
        ["Viễn Tưởng", "/genre/sci-fi/page/"],
        ["Tâm Lý", "/genre/drama/page/"],
        ["Lãng Mạn", "/genre/romance/page/"],
        ["Hoạt Hình", "/genre/animation/page/"],
        ["Hình Sự", "/genre/crime/page/"],
        ["Gia Đình", "/genre/gia-dinh/page/"],
        ["Hàn Quốc", "/genre/korean/page/"],
        ["Trung Quốc", "/genre/trung-quoc-series/page/"],
        ["4K", "/genre/4k/page/"],
        ["3D", "/genre/3d/page/"],
        ["Tài Liệu", "/genre/documentary/page/"],
    ];

    // ── getHome ───────────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            const base = getSiteBase();
            const data = {};
            await Promise.all(CATEGORIES.slice(0, 6).map(async ([name, path]) => {
                try {
                    const html = await httpGet(`${base}${path}1`);
                    const doc = parseHtml(html);
                    const items = Array.from(doc.querySelectorAll("div.items article, div.result-item article"))
                        .map(parseArticle).filter(Boolean);
                    if (items.length > 0) data[name] = items;
                } catch (_) { }
            }));
            await Promise.all(CATEGORIES.slice(6).map(async ([name, path]) => {
                try {
                    const html = await httpGet(`${base}${path}1`);
                    const doc = parseHtml(html);
                    const items = Array.from(doc.querySelectorAll("div.items article, div.result-item article"))
                        .map(parseArticle).filter(Boolean);
                    if (items.length > 0) data[name] = items;
                } catch (_) { }
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
            const doc = parseHtml(html);
            const items = Array.from(doc.querySelectorAll("div.result-item article, div.items article"))
                .map(parseArticle).filter(Boolean);
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.stack || String(e) });
        }
    }

    // ── load ──────────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            const html = await httpGet(url, { Referer: getSiteBase() });
            const doc = parseHtml(html);

            const title = doc.querySelector("div.sheader div.data h1, h1.entry-title")?.textContent?.trim();
            if (!title) return cb({ success: false, errorCode: "NOT_FOUND", message: "Không tìm thấy tiêu đề" });

            const posterEl = doc.querySelector("div.poster img, div.sheader div.poster img");
            const poster = getPosterFromImg(posterEl);
            const description = doc.querySelector("div#info div.wp-content p, div.wp-content p")?.textContent?.trim();
            const year = parseInt(doc.querySelector("span.date")?.textContent?.trim()?.slice(-4)) || null;
            const tags = Array.from(doc.querySelectorAll("div.sgeneros a, a[href*='/genre/']")).map(a => a.textContent.trim());
            const actors = Array.from(doc.querySelectorAll(
                "[itemprop='actor'] .name a, [itemprop='actor'] a, div.person span.name a, a[href*='/actor/'], a[href*='/cast/']"
            )).map(a => new Actor({ name: a.textContent.trim() })).filter(a => a.name);

            const htmlRecs = Array.from(doc.querySelectorAll(
                "div.owl-item article, div.srelac article, div#single_relacionados article, section.related article"
            )).map(el => {
                const titleEl = el.querySelector("div.data h3 a, h3 a, a[title]");
                const rTitle = titleEl?.textContent?.trim() || el.querySelector("a")?.getAttribute("title");
                const rUrl = titleEl?.getAttribute("href") || el.querySelector("a")?.getAttribute("href");
                const img = el.querySelector("img");
                const rPoster = getPosterFromImg(img);
                if (!rTitle || !rUrl) return null;
                return new MultimediaItem({ title: rTitle, url: rUrl, posterUrl: rPoster, type: "movie" });
            }).filter(Boolean);

            const isSeries = tags.some(t => t.toLowerCase().includes("phim bộ") || t.toLowerCase().includes("series"))
                || doc.querySelector("div.episodios li, ul.episodios li") !== null;

            // Collect Fshare entries from HTML table (ThuVienHD specific)
            const fshareEntries = [];

            doc.querySelectorAll("table.post_table tbody.outer tr").forEach(row => {
                const link = row.querySelector("a.face-button[href*='fshare.vn']");
                if (!link) return;
                const fshareUrl = link.getAttribute("href")?.trim();
                if (!fshareUrl) return;
                const fileName = row.querySelector("td span")?.textContent?.trim()
                    || link.getAttribute("title")?.trim()
                    || fshareUrl.split("/").pop();
                const sizeRaw = link.querySelector("div.face-secondary")?.textContent || "";
                const sizeMatch = sizeRaw.match(/([\d.,]+)\s*(GB|MB|KB|TB)/i);
                const fileSize = sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2]}` : "";
                fshareEntries.push({ url: fshareUrl, fileName, fileSize });
            });

            // Fallback if table is empty
            if (fshareEntries.length === 0) {
                doc.querySelectorAll("a[href*='fshare.vn']").forEach(a => {
                    const href = a.getAttribute("href");
                    if (href && !fshareEntries.some(e => e.url === href)) {
                        const name = a.getAttribute("title")?.trim() || href.split("/").pop();
                        fshareEntries.push({ url: href, fileName: name, fileSize: "" });
                    }
                });
            }

            // Check download page
            if (fshareEntries.length === 0) {
                const dlLink = doc.querySelector("a[href*='/download?id=']")?.getAttribute("href");
                if (dlLink) {
                    try {
                        const dlUrl = dlLink.startsWith("http") ? dlLink : `${getSiteBase()}${dlLink}`;
                        const dlHtml = await httpGet(dlUrl, { Referer: url });
                        const dlDoc = parseHtml(dlHtml);
                        dlDoc.querySelectorAll("a[href*='fshare.vn']").forEach(a => {
                            const href = a.getAttribute("href");
                            if (href && !fshareEntries.some(e => e.url === href)) {
                                fshareEntries.push({ url: href, fileName: href.split("/").pop(), fileSize: "" });
                            }
                        });
                    } catch (_) { }
                }
            }

            const fshareLinks = fshareEntries.map(e => e.url);
            const hasFolderLinks = fshareLinks.some(l => l.includes("/folder/"));
            const isSeriesFinal = isSeries || hasFolderLinks || fshareEntries.length > 1;

            // ── TMDB enrichment ──────────────────────────────────────────────────
            let tmdbPoster = null, tmdbBanner = null, tmdbPlot = null;
            let tmdbActors = null, tmdbTags = null, tmdbRecs = null, tmdbYear = null, tmdbScore = null;
            try {
                const tmdb = await searchTmdb(title, year, isSeriesFinal);
                if (tmdb) {
                    const d = await getTmdbDetails(tmdb.id, tmdb.type);
                    if (d) {
                        const viPoster = d.images?.posters?.find(p => p.iso_639_1 === "vi")?.file_path;
                        const viBackdrop = d.images?.backdrops?.find(p => p.iso_639_1 === "vi")?.file_path;
                        tmdbPoster = tmdbImg(viPoster || d.poster_path, "w500");
                        tmdbBanner = tmdbImg(viBackdrop || d.backdrop_path, "original");
                        tmdbPlot = d.overview || null;
                        tmdbScore = d.vote_average ? Math.round(d.vote_average * 10) / 10 : null;
                        tmdbYear = parseInt((d.release_date || d.first_air_date || "").slice(0, 4)) || null;
                        tmdbTags = d.genres?.map(g => g.name);
                        tmdbActors = d.credits?.cast?.slice(0, 10).map(m =>
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
            } catch (_) { }

            const finalPoster = tmdbPoster || poster || "";
            const finalBanner = tmdbBanner || finalPoster;
            const finalPlot = tmdbPlot || description;
            const finalTags = (tmdbTags && tmdbTags.length > 0) ? tmdbTags : tags;
            const finalActors = (tmdbActors && tmdbActors.length > 0) ? tmdbActors : actors;
            const finalRecs = (tmdbRecs && tmdbRecs.length > 0) ? tmdbRecs : htmlRecs;
            const finalYear = tmdbYear || year;

            if (isSeriesFinal) {
                const episodes = [];
                const epEls = doc.querySelectorAll("div.episodios li, ul.episodios li");
                if (epEls.length > 0) {
                    epEls.forEach((ep, idx) => {
                        const epTitle = ep.querySelector("a")?.textContent?.trim() || `Tập ${idx + 1}`;
                        const epLink = ep.querySelector("a")?.getAttribute("href") || url;
                        episodes.push(new Episode({ name: epTitle, url: epLink, season: 1, episode: idx + 1 }));
                    });
                } else {
                    const folderLinks = fshareLinks.filter(l => l.includes("/folder/"));
                    const fileEntries = fshareEntries.filter(e => !e.url.includes("/folder/"));
                    let seasonIndex = 1;

                    for (const rootFolder of folderLinks) {
                        try {
                            const items = await fshareFolderList(rootFolder);
                            if (!items) throw new Error("api_fail");
                            const subFolders = items.filter(i => i.isFolder);
                            const rootFiles = items.filter(i => !i.isFolder);

                            if (subFolders.length > 0) {
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

                    // Standalone file links (from table)
                    fileEntries.forEach((entry, idx) => {
                        const displayName = entry.fileSize ? `(${entry.fileSize}) - ${entry.fileName}` : entry.fileName;
                        episodes.push(new Episode({
                            name: entry.fileName, season: folderLinks.length > 0 ? seasonIndex : 1, episode: idx + 1,
                            url: `${entry.url}|||${entry.fileSize}|||${entry.fileName}`,
                            description: displayName, posterUrl: finalPoster
                        }));
                    });
                }

                cb({
                    success: true, data: new MultimediaItem({
                        title, url, type: "series",
                        posterUrl: finalPoster, bannerUrl: finalBanner,
                        description: finalPlot, year: finalYear,
                        score: tmdbScore, tags: finalTags,
                        cast: finalActors, recommendations: finalRecs, episodes
                    })
                });

            } else {
                // Movie
                const movieData = fshareEntries.length > 0
                    ? `__FSHARE__${JSON.stringify(fshareEntries.map(e => ({ url: e.url, name: e.fileName })))}`
                    : url;

                cb({
                    success: true, data: new MultimediaItem({
                        title, url: movieData, type: "movie",
                        posterUrl: finalPoster, bannerUrl: finalBanner,
                        description: finalPlot, year: finalYear,
                        score: tmdbScore, tags: finalTags,
                        cast: finalActors, recommendations: finalRecs
                    })
                });
            }
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.stack || String(e) });
        }
    }

    // ── loadStreams ───────────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            const streams = [];

            if (url.includes("|||")) {
                const parts = url.split("|||");
                const fUrl = parts[0];
                const sizeStr = parts[1] || "";
                const fileName = parts[2] || "";
                if (fUrl.includes("/folder/")) {
                    const files = await fshareFolderList(fUrl);
                    if (files) {
                        await Promise.all(files.filter(f => !f.isFolder).map(async file => {
                            const direct = await fshareGetLink(file.linkcode);
                            if (direct) streams.push(new StreamResult({
                                url: direct, source: `(${file.sizeStr}) ${file.name}`,
                                quality: getQuality(file.name),
                                headers: { Referer: "https://www.fshare.vn/" }
                            }));
                        }));
                    }
                } else {
                    const linkCode = fUrl.split("/").pop().split("?")[0];
                    const direct = await fshareGetLink(linkCode);
                    if (direct) {
                        const label = sizeStr && fileName ? `(${sizeStr}) ${fileName}` : (fileName || linkCode);
                        streams.push(new StreamResult({
                            url: direct, source: label, quality: getQuality(fileName || fUrl),
                            headers: { Referer: "https://www.fshare.vn/" }
                        }));
                    }
                }

            } else if (url.startsWith("__FSHARE__")) {
                const refs = JSON.parse(url.slice("__FSHARE__".length));
                await Promise.all(refs.map(async ({ url: fUrl, name }) => {
                    const linkCode = fUrl.split("/").pop().split("?")[0];
                    const direct = await fshareGetLink(linkCode);
                    if (direct) streams.push(new StreamResult({
                        url: direct, source: name || linkCode,
                        quality: getQuality(name || fUrl),
                        headers: { Referer: "https://www.fshare.vn/" }
                    }));
                }));

            } else if (url.includes("fshare.vn")) {
                const linkCode = url.split("/").pop().split("?")[0];
                const direct = await fshareGetLink(linkCode);
                if (direct) streams.push(new StreamResult({
                    url: direct, source: "Fshare Direct",
                    headers: { Referer: "https://www.fshare.vn/" }
                }));

            } else {
                try {
                    const html = await httpGet(url, { Referer: getSiteBase() });
                    const doc = parseHtml(html);
                    const links = Array.from(doc.querySelectorAll("a[href*='fshare.vn']"))
                        .map(a => a.getAttribute("href")).filter(Boolean);
                    await Promise.all(links.map(async (fUrl, idx) => {
                        const linkCode = fUrl.split("/").pop().split("?")[0];
                        const direct = await fshareGetLink(linkCode);
                        if (direct) streams.push(new StreamResult({
                            url: direct, source: `Stream ${idx + 1}`,
                            headers: { Referer: "https://www.fshare.vn/" }
                        }));
                    }));
                } catch (_) { }
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

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
